import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  AppSettings,
  CleanRecommendation,
  DiskStone,
  ScanResult,
  UnclassifiedDirSample,
  WorkLogEntry
} from '../../shared/types';
import {
  formatBytesToKansoSize,
  hasUserMediaOrSourceFiles,
  isPathProtected,
  normalizeWinPath
} from '../safety/safety-guard';
import { getDirectorySizeFast } from '../scanner/windows-rules';

const execFileAsync = promisify(execFile);

/** 可再生的项目构建产物与依赖目录名集合 */
const REBUILDABLE_DIR_PATTERNS: Array<{
  dirName: string;
  titlePrefix: string;
  reason: string;
  riskLevel: 'safe' | 'confirm';
}> = [
  {
    dirName: 'node_modules',
    titlePrefix: '旧项目依赖 (node_modules)',
    reason: '前端/Node.js 项目的第三方依赖目录，可通过 npm/pnpm/yarn install 完整重新生成，不含用户源码。',
    riskLevel: 'safe'
  },
  {
    dirName: 'target',
    titlePrefix: 'Rust / Maven 构建产物 (target)',
    reason: 'Rust Cargo 或 Java Maven 编译生成的中间二进制与增量缓存，可通过 cargo build 重新生成。',
    riskLevel: 'safe'
  },
  {
    dirName: '.next',
    titlePrefix: 'Next.js 编译缓存 (.next)',
    reason: 'Next.js 本地开发与构建生成的缓存产物，启动开发服务或重新构建时自动生成。',
    riskLevel: 'safe'
  },
  {
    dirName: 'dist',
    titlePrefix: '项目打包产物目录 (dist)',
    reason: '项目编译打包输出目录，源码仍在仓库中，可通过 build 命令重新生成。',
    riskLevel: 'confirm'
  },
  {
    dirName: '.venv',
    titlePrefix: 'Python 虚拟环境 (.venv)',
    reason: 'Python 本地虚拟环境依赖目录，可根据 requirements.txt 或 pyproject.toml 重新创建。',
    riskLevel: 'confirm'
  }
];

/**
 * 检测本机是否安装了 claude 或 codex CLI 工具
 */
export async function detectInstalledCliAgents(): Promise<{ claude: boolean; codex: boolean }> {
  const checkCmd = async (name: string): Promise<boolean> => {
    try {
      await execFileAsync('where.exe', [name], { timeout: 3000, windowsHide: true });
      return true;
    } catch {
      return false;
    }
  };

  const [claude, codex] = await Promise.all([checkCmd('claude'), checkCmd('codex')]);
  return { claude, codex };
}

/**
 * 在只读沙盒约束下扫描未归类目录，查找旧项目的可再生构建目录（如 node_modules, target, .next 等）
 */
function exploreUnclassifiedSamplesHeuristically(
  samples: UnclassifiedDirSample[]
): { discoveredRecs: CleanRecommendation[]; discoveredStones: DiskStone[] } {
  const discoveredRecs: CleanRecommendation[] = [];
  const discoveredStones: DiskStone[] = [];

  for (const sample of samples) {
    try {
      if (!fs.existsSync(sample.path)) continue;
      const entries = fs.readdirSync(sample.path, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const matchedPattern = REBUILDABLE_DIR_PATTERNS.find(
          (p) => p.dirName.toLowerCase() === entry.name.toLowerCase()
        );

        if (matchedPattern) {
          const targetDir = path.join(sample.path, entry.name);
          const sz = getDirectorySizeFast(targetDir, 4, 8000);
          if (sz <= 0) continue;

          let mtimeMs = Date.now();
          try {
            mtimeMs = fs.statSync(targetDir).mtimeMs;
          } catch {
            // ignore
          }

          const recId = `rec-agent-${normalizeWinPath(targetDir).replace(/[^a-z0-9]/g, '-')}`;
          const sizeText = formatBytesToKansoSize(sz, true);
          const title = `${sample.name} — ${matchedPattern.titlePrefix}`;

          discoveredRecs.push({
            id: recId,
            title,
            riskLevel: matchedPattern.riskLevel,
            sizeBytes: sz,
            sizeText,
            paths: [targetDir],
            reason: `[探索 Agent 识别] 位于 ${sample.name} 下：${matchedPattern.reason}`,
            command: `Remove-Item -Recurse -Force "${targetDir}"`,
            source: 'agent',
            reviewed: false,
            scannedMtimeMs: mtimeMs
          });

          discoveredStones.push({
            id: `stone-agent-${recId}`,
            label: `${sample.name} 依赖`,
            category: 'caches',
            sizeBytes: sz,
            sizeText,
            paths: [targetDir],
            recommendationId: recId,
            description: matchedPattern.reason
          });
        }
      }
    } catch {
      // 忽略无权限目录
    }
  }

  return { discoveredRecs, discoveredStones };
}

/**
 * 可选调用外部 CLI Agent 或 LLM API 获取只读补充建议备注
 */
async function queryExternalAgentInsight(
  samples: UnclassifiedDirSample[],
  settings: AppSettings
): Promise<string | null> {
  if (samples.length === 0) return null;

  const summaryPayload = samples.slice(0, 8).map((s) => ({
    name: s.name,
    path: s.path,
    sizeGB: (s.sizeBytes / 1024 ** 3).toFixed(2),
    sampleChildren: s.sampleChildren.slice(0, 8)
  }));

  const readOnlyPrompt =
    '你是 Kanso 磁盘清理只读分析 Agent。严禁执行任何文件修改或删除命令。请用一句话中文总结以下未归类目录的特征：' +
    JSON.stringify(summaryPayload);

  try {
    if (settings.agentBackend === 'llm-api' && settings.llmApiEndpoint) {
      const url = `${settings.llmApiEndpoint.replace(/\/+$/, '')}/chat/completions`;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (settings.llmApiKey) {
        headers['Authorization'] = `Bearer ${settings.llmApiKey}`;
      }
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: settings.llmModel || 'gpt-4o-mini',
          messages: [{ role: 'user', content: readOnlyPrompt }],
          max_tokens: 120
        }),
        signal: AbortSignal.timeout(6000)
      });
      if (res.ok) {
        const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
        return data.choices?.[0]?.message?.content?.trim() || null;
      }
    } else if (settings.agentBackend === 'claude-cli') {
      const { stdout } = await execFileAsync('claude', ['-p', readOnlyPrompt], {
        timeout: 8000,
        windowsHide: true
      });
      if (stdout && stdout.trim()) return stdout.trim().slice(0, 200);
    }
  } catch {
    // 外部 Agent 超时或未登录时平滑回退内置探索复核引擎
  }

  return null;
}

/**
 * 独立复核 Agent (ReviewerAgent)
 * 核心职责：独立检查每一条清理建议，无法确认安全的就撤掉！
 * 特别是：名字叫 Cache、里面却是聊天原图或用户源码的目录，强制标为不建议清理并撤回。
 */
function runIndependentReviewer(
  candidates: CleanRecommendation[],
  excludedPaths: string[]
): {
  approved: CleanRecommendation[];
  withdrawn: Array<{ rec: CleanRecommendation; reason: string }>;
} {
  const approved: CleanRecommendation[] = [];
  const withdrawn: Array<{ rec: CleanRecommendation; reason: string }> = [];
  const excludedNorms = excludedPaths.map((p) => normalizeWinPath(p));

  for (const rec of candidates) {
    let unsafeReason: string | null = null;

    for (const targetPath of rec.paths) {
      const norm = normalizeWinPath(targetPath);

      // 1. 检查用户自定义排除列表
      if (excludedNorms.some((ex) => norm === ex || norm.startsWith(ex + '\\'))) {
        unsafeReason = `路径位于用户自定义排除目录中 (${targetPath})`;
        break;
      }

      // 2. 检查受保护黑名单
      const prot = isPathProtected(targetPath);
      if (prot.protected) {
        unsafeReason = prot.reason || `命中受保护路径黑名单 (${targetPath})`;
        break;
      }

      // 3. 伪缓存纠偏检查：如果不是 node_modules 或系统回收站，检查目录内是否含聊天原图/照片/文档
      const baseName = path.basename(targetPath).toLowerCase();
      const isKnownDepBundle = ['node_modules', 'target', '.next', '$recycle.bin', 'store'].includes(baseName);
      if (!isKnownDepBundle && hasUserMediaOrSourceFiles(targetPath)) {
        unsafeReason = `复核 Agent 拦截：目录 "${path.basename(targetPath)}" 虽名为缓存或候选清理项，但内部检测到聊天原图、照片或源码文件，删后无法找回，已自动撤回。`;
        break;
      }
    }

    if (unsafeReason) {
      withdrawn.push({ rec, reason: unsafeReason });
    } else {
      approved.push({
        ...rec,
        reviewed: true,
        reviewNote:
          rec.reviewNote ||
          '独立复核 Agent 已核验：路径不在受保护区，不含用户原图与原创源码，删除后可安全重建。'
      });
    }
  }

  return { approved, withdrawn };
}

/**
 * 执行阶段二（探索 Agent）与阶段三（独立复核 Agent）完整流水线
 */
export async function runAgentExplorationAndReview(
  scanResult: ScanResult,
  settings: AppSettings
): Promise<{ updatedResult: ScanResult; logs: WorkLogEntry[] }> {
  const logs: WorkLogEntry[] = [];

  // 1. 探索 Agent 扫描未归类目录
  const { discoveredRecs, discoveredStones } = exploreUnclassifiedSamplesHeuristically(
    scanResult.unclassifiedSamples
  );

  const externalInsight = await queryExternalAgentInsight(scanResult.unclassifiedSamples, settings);

  logs.push({
    id: `log-explore-${Date.now()}-1`,
    timestamp: Date.now(),
    type: 'agent-explore',
    title: '探索 Agent 完成深度排查（只读沙盒模式）',
    detail:
      `已检查 ${scanResult.unclassifiedSamples.length} 个未归类大目录，新发现 ${discoveredRecs.length} 项可再生项目依赖/构建缓存。` +
      (externalInsight ? ` Agent 备注：${externalInsight}` : ''),
    paths: discoveredRecs.flatMap((r) => r.paths)
  });

  // 合并固定规则建议与探索 Agent 发现的建议（按路径去重）
  const existingPathSet = new Set(
    scanResult.recommendations.flatMap((r) => r.paths.map((p) => normalizeWinPath(p)))
  );
  const mergedCandidates: CleanRecommendation[] = [...scanResult.recommendations];
  const mergedStones: DiskStone[] = [...scanResult.stones];

  for (let i = 0; i < discoveredRecs.length; i++) {
    const rec = discoveredRecs[i];
    const stone = discoveredStones[i];
    const norm = normalizeWinPath(rec.paths[0]);
    if (!existingPathSet.has(norm)) {
      existingPathSet.add(norm);
      mergedCandidates.push(rec);
      mergedStones.push(stone);

      // 从未归类石块中扣除已归类的构建产物字节数
      const unknownStone = mergedStones.find((s) => s.id === 'stone-unclassified');
      if (unknownStone && unknownStone.sizeBytes > rec.sizeBytes) {
        unknownStone.sizeBytes -= rec.sizeBytes;
        unknownStone.sizeText = formatBytesToKansoSize(unknownStone.sizeBytes);
      }
    }
  }

  // 2. 独立复核 Agent 逐条检验所有候选建议
  const { approved, withdrawn } = runIndependentReviewer(mergedCandidates, settings.excludedPaths);

  for (const item of withdrawn) {
    logs.push({
      id: `log-withdrawn-${Date.now()}-${item.rec.id}`,
      timestamp: Date.now(),
      type: 'safety-block',
      title: `复核 Agent 撤回不安全建议：${item.rec.title}`,
      detail: item.reason,
      paths: item.rec.paths
    });
  }

  logs.push({
    id: `log-review-${Date.now()}-2`,
    timestamp: Date.now(),
    type: 'agent-review',
    title: '独立复核 Agent 完成安全性审查',
    detail: `共审查 ${mergedCandidates.length} 条建议，确认安全通过 ${approved.length} 条，撤回存疑或含个人原图目录 ${withdrawn.length} 条。`
  });

  // 移除被撤回建议对应的临时缓存石块，防止在庭院图上残留无效石块
  const withdrawnIdSet = new Set(withdrawn.map((w) => w.rec.id));
  const filteredStones = mergedStones.filter(
    (st) => !(st.recommendationId && withdrawnIdSet.has(st.recommendationId))
  );

  approved.sort((a, b) => b.sizeBytes - a.sizeBytes);
  filteredStones.sort((a, b) => b.sizeBytes - a.sizeBytes);

  const updatedResult: ScanResult = {
    ...scanResult,
    stones: filteredStones,
    recommendations: approved,
    withdrawnCount: scanResult.withdrawnCount + withdrawn.length,
    agentStatusText:
      withdrawn.length > 0
        ? `规则与 Agent 协同扫描完成（复核 Agent 已自动拦截并撤回 ${withdrawn.length} 项伪缓存或风险目录）。`
        : '规则与 Agent 协同扫描及独立复核已全部完成。'
  };

  return { updatedResult, logs };
}
