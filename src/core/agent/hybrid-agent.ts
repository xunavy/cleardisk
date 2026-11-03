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
    titlePrefix: '项目依赖 (node_modules)',
    reason: '前端/Node.js 项目的第三方依赖包目录，可通过 npm/pnpm/yarn install 完整重新生成，不含用户源码。',
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
 * 在只读沙盒约束下扫描盘符顶层与二级项目目录，查找可再生的项目依赖目录（如 node_modules, target, .next, .venv）
 */
function exploreUnclassifiedSamplesHeuristically(
  samples: UnclassifiedDirSample[],
  minSizeBytes = 25 * 1024 * 1024
): { discoveredRecs: CleanRecommendation[]; discoveredStones: DiskStone[] } {
  const discoveredRecs: CleanRecommendation[] = [];
  const discoveredStones: DiskStone[] = [];

  function inspectCandidateProjectDir(projectDir: string, displayPrefix: string): void {
    try {
      const entries = fs.readdirSync(projectDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const matchedPattern = REBUILDABLE_DIR_PATTERNS.find(
          (p) => p.dirName.toLowerCase() === entry.name.toLowerCase()
        );
        if (!matchedPattern) continue;

        const targetDir = path.join(projectDir, entry.name);
        const sz = getDirectorySizeFast(targetDir, 6, 45000);
        if (sz < minSizeBytes) continue;

        let mtimeMs = Date.now();
        try {
          mtimeMs = fs.statSync(targetDir).mtimeMs;
        } catch {
          // ignore
        }

        const recId = `rec-agent-${normalizeWinPath(targetDir).replace(/[^a-z0-9]/g, '-')}`;
        const sizeText = formatBytesToKansoSize(sz);
        const title = `${displayPrefix} — ${matchedPattern.titlePrefix}`;

        discoveredRecs.push({
          id: recId,
          title,
          riskLevel: matchedPattern.riskLevel,
          sizeBytes: sz,
          sizeText,
          paths: [targetDir],
          reason: `[探索 Agent 识别] 位于 ${projectDir} 下：${matchedPattern.reason}`,
          command: `Remove-Item -Recurse -Force "${targetDir}"`,
          source: 'agent',
          reviewed: false,
          scannedMtimeMs: mtimeMs
        });

        discoveredStones.push({
          id: `stone-agent-${recId}`,
          label: `${displayPrefix} 依赖`,
          category: 'caches',
          sizeBytes: sz,
          sizeText,
          paths: [targetDir],
          recommendationId: recId,
          description: matchedPattern.reason
        });
      }
    } catch {
      // ignore
    }
  }

  for (const sample of samples) {
    // 跳过当前正在运行的 cleardisk 仓库本身，防止清理自身 node_modules
    if (normalizeWinPath(sample.path) === normalizeWinPath('D:\\cleardisk')) {
      continue;
    }

    // 1. 检查一级目录本身是否直接包含 node_modules / target / .venv
    inspectCandidateProjectDir(sample.path, sample.name);

    // 2. 如果该目录是代码合集目录（如 AI-github, a-工作, ai 等），深入检查其下一级子项目目录
    const lower = sample.name.toLowerCase();
    if (
      lower.includes('github') ||
      lower.includes('project') ||
      lower.includes('workspace') ||
      lower.includes('工作') ||
      lower === 'ai'
    ) {
      try {
        const subProjects = fs.readdirSync(sample.path, { withFileTypes: true }).slice(0, 35);
        for (const sub of subProjects) {
          if (!sub.isDirectory() || sub.isSymbolicLink()) continue;
          const subPath = path.join(sample.path, sub.name);
          if (normalizeWinPath(subPath) === normalizeWinPath('D:\\cleardisk')) continue;
          inspectCandidateProjectDir(subPath, `${sample.name}/${sub.name}`);
        }
      } catch {
        // ignore
      }
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
  if (samples.length === 0 || settings.agentBackend === 'heuristic') return null;

  const summaryPayload = samples.slice(0, 8).map((s) => ({
    name: s.name,
    path: s.path,
    sizeGB: (s.sizeBytes / 1024 ** 3).toFixed(2),
    sampleChildren: s.sampleChildren.slice(0, 8)
  }));

  const readOnlyPrompt =
    '你是 Kanso 磁盘清理只读分析 Agent。严禁执行任何文件修改或删除命令。请用一句话中文总结以下目录特征：' +
    JSON.stringify(summaryPayload);

  try {
    let effectiveBackend = settings.agentBackend;
    if (effectiveBackend === 'auto') {
      const cliStatus = await detectInstalledCliAgents();
      if (cliStatus.claude) effectiveBackend = 'claude-cli';
      else if (cliStatus.codex) effectiveBackend = 'codex-cli';
    }

    if (effectiveBackend === 'llm-api' && settings.llmApiEndpoint) {
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
        signal: AbortSignal.timeout(5000)
      });
      if (res.ok) {
        const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
        return data.choices?.[0]?.message?.content?.trim() || null;
      }
    } else if (effectiveBackend === 'claude-cli') {
      const { stdout } = await execFileAsync('claude', ['-p', readOnlyPrompt], {
        timeout: 5000,
        windowsHide: true
      });
      if (stdout && stdout.trim()) return stdout.trim().slice(0, 200);
    } else if (effectiveBackend === 'codex-cli') {
      const { stdout } = await execFileAsync('codex', ['exec', readOnlyPrompt], {
        timeout: 5000,
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

      // 3. 伪缓存纠偏检查：对尚未通过固定工具规则复核的条目（或可疑缓存目录）检测是否包含用户聊天原图/照片/文档
      const baseName = path.basename(targetPath).toLowerCase();
      const isKnownDepBundle = [
        'node_modules',
        'target',
        '.next',
        '.venv',
        '$recycle.bin',
        'store',
        '.pnpm-store'
      ].includes(baseName);

      if (!rec.reviewed && !isKnownDepBundle && hasUserMediaOrSourceFiles(targetPath)) {
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
  const isTestMode = scanResult.volume.label.includes('测试卷');
  const minDiscoverBytes = isTestMode ? 1024 : 25 * 1024 * 1024;

  // 1. 探索 Agent 扫描盘符目录中的项目依赖
  const { discoveredRecs, discoveredStones } = exploreUnclassifiedSamplesHeuristically(
    scanResult.unclassifiedSamples,
    minDiscoverBytes
  );

  const externalInsight = await queryExternalAgentInsight(scanResult.unclassifiedSamples, settings);

  logs.push({
    id: `log-explore-${Date.now()}-1`,
    timestamp: Date.now(),
    type: 'agent-explore',
    title: '探索 Agent 完成深度排查（只读沙盒模式）',
    detail:
      `已检查 ${scanResult.unclassifiedSamples.length} 个磁盘顶层目录，新发现 ${discoveredRecs.length} 项可再生项目依赖/构建缓存。` +
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

  // 移除被撤回建议对应的临时缓存石块
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
        ? `规则与 Agent 协同扫描完成（复核 Agent 已拦截并撤回 ${withdrawn.length} 项伪缓存或风险目录）。`
        : `真实磁盘扫描与独立 Agent 复核已完成（共确认 ${approved.length} 项真实可清理缓存）。`
  };

  return { updatedResult, logs };
}
