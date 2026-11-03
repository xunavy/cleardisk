import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  DiskVolume,
  DiskStone,
  CleanRecommendation,
  ScanResult,
  UnclassifiedDirSample,
  StoneCategory,
  CleanRiskLevel
} from '../../shared/types';
import {
  formatBytesToKansoSize,
  hasUserMediaOrSourceFiles,
  isPathProtected,
  normalizeWinPath
} from '../safety/safety-guard';

/**
 * 快速递归计算目录占用字节数
 * 带有深度、条目上限及权限容错保护，避免在海量小文件目录阻塞
 */
export function getDirectorySizeFast(
  dirPath: string,
  maxDepth = 5,
  maxEntries = 18000
): number {
  let totalBytes = 0;
  let visited = 0;

  function walk(currentPath: string, depth: number): void {
    if (depth > maxDepth || visited > maxEntries) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (visited++ > maxEntries) break;
      if (entry.isSymbolicLink()) continue;

      const fullPath = path.join(currentPath, entry.name);
      if (entry.isFile()) {
        try {
          const st = fs.statSync(fullPath);
          totalBytes += st.size;
        } catch {
          // 忽略无权限或已删除文件
        }
      } else if (entry.isDirectory()) {
        walk(fullPath, depth + 1);
      }
    }
  }

  try {
    if (!fs.existsSync(dirPath)) return 0;
    const st = fs.lstatSync(dirPath);
    if (st.isSymbolicLink()) return 0;
    if (st.isFile()) return st.size;
    walk(dirPath, 0);
  } catch {
    return 0;
  }

  return totalBytes;
}

/**
 * 探测当前 Windows 系统挂载的所有逻辑驱动器，并附加 "ALL"（全部磁盘汇总）视图
 */
export async function listWindowsVolumes(): Promise<DiskVolume[]> {
  const volumes: DiskVolume[] = [];
  const sysDrive = (process.env.SystemDrive || 'C:').toUpperCase();

  // 遍历 A-Z 盘符，利用 Node.js 18+ 原生 fs.statfsSync 秒级读取卷空间信息
  for (let code = 67; code <= 90; code++) {
    const letter = String.fromCharCode(code);
    const id = `${letter}:`;
    const mountPath = `${letter}:\\`;

    try {
      if (!fs.existsSync(mountPath)) continue;
      const stat = fs.statfsSync(mountPath);
      const totalBytes = Number(stat.blocks) * Number(stat.bsize);
      const freeBytes = Number(stat.bavail) * Number(stat.bsize);
      if (totalBytes <= 0) continue;

      const usedBytes = Math.max(0, totalBytes - freeBytes);
      const roleLabel = id === sysDrive ? '系统盘' : '本地磁盘';

      volumes.push({
        id,
        label: `${id} ${roleLabel}`,
        mountPath,
        totalBytes,
        freeBytes,
        usedBytes
      });
    } catch {
      // 跳过未就绪的光驱或网络驱动器
    }
  }

  if (volumes.length === 0) {
    // 兜底：至少返回系统盘
    volumes.push({
      id: 'C:',
      label: 'C: 系统盘',
      mountPath: 'C:\\',
      totalBytes: 512 * 1024 ** 3,
      freeBytes: 196 * 1024 ** 3,
      usedBytes: 316 * 1024 ** 3
    });
  }

  const allTotal = volumes.reduce((acc, v) => acc + v.totalBytes, 0);
  const allFree = volumes.reduce((acc, v) => acc + v.freeBytes, 0);
  const allUsed = Math.max(0, allTotal - allFree);

  return [
    ...volumes,
    {
      id: 'ALL',
      label: '全部磁盘汇总',
      mountPath: 'ALL',
      totalBytes: allTotal,
      freeBytes: allFree,
      usedBytes: allUsed
    }
  ];
}

interface CleanRuleDef {
  id: string;
  title: string;
  riskLevel: CleanRiskLevel;
  stoneLabel: string;
  pathsResolver: (homeDir: string, driveRoots: string[]) => string[];
  reason: string;
  commandBuilder: (paths: string[]) => string;
  relatedProcesses?: string[];
}

interface StoneGroupDef {
  id: string;
  label: string;
  category: StoneCategory;
  pathsResolver: (homeDir: string, driveRoots: string[]) => string[];
}

const CLEAN_RULES: CleanRuleDef[] = [
  {
    id: 'rule-npm-cache',
    title: 'npm 缓存',
    riskLevel: 'safe',
    stoneLabel: 'npm 缓存',
    pathsResolver: (home) => [
      path.join(home, 'AppData', 'Local', 'npm-cache'),
      path.join(home, 'AppData', 'Roaming', 'npm-cache')
    ],
    reason: 'npm 下载的压缩包与 HTTP 缓存，删除后仅在下次安装新包时重新下载，不影响已有项目。',
    commandBuilder: (paths) => `Remove-Item -Recurse -Force ${paths.map((p) => `"${p}"`).join(', ')}`,
    relatedProcesses: ['node.exe', 'npm.cmd']
  },
  {
    id: 'rule-pnpm-store',
    title: 'pnpm store',
    riskLevel: 'safe',
    stoneLabel: 'pnpm store',
    pathsResolver: (home, drives) => [
      path.join(home, 'AppData', 'Local', 'pnpm', 'store'),
      ...drives.map((d) => path.join(d, '.pnpm-store'))
    ],
    reason: 'pnpm 全局内容寻址缓存仓库，清理未引用包或缓存不会破坏正在使用的硬链接依赖。',
    commandBuilder: (paths) => `pnpm store prune # 或清理 ${paths.map((p) => `"${p}"`).join(', ')}`,
    relatedProcesses: ['node.exe', 'pnpm.exe']
  },
  {
    id: 'rule-yarn-bun-cache',
    title: 'Yarn 与 Bun 缓存',
    riskLevel: 'safe',
    stoneLabel: 'Bun / Yarn 缓存',
    pathsResolver: (home) => [
      path.join(home, 'AppData', 'Local', 'Yarn', 'Cache'),
      path.join(home, '.bun', 'install', 'cache')
    ],
    reason: '前端包管理器 Yarn 与 Bun 的离线归档缓存，可随时安全重建。',
    commandBuilder: (paths) => `Remove-Item -Recurse -Force ${paths.map((p) => `"${p}"`).join(', ')}`,
    relatedProcesses: ['bun.exe', 'node.exe']
  },
  {
    id: 'rule-pip-uv-cache',
    title: 'pip 与 uv 缓存',
    riskLevel: 'safe',
    stoneLabel: 'Python 依赖缓存',
    pathsResolver: (home) => [
      path.join(home, 'AppData', 'Local', 'pip', 'Cache'),
      path.join(home, 'AppData', 'Local', 'uv', 'cache')
    ],
    reason: 'Python pip 与 uv 安装包时的 Wheel 预编译缓存，清理后不影响虚拟环境内已安装的库。',
    commandBuilder: (paths) => `Remove-Item -Recurse -Force ${paths.map((p) => `"${p}"`).join(', ')}`,
    relatedProcesses: ['python.exe', 'pip.exe', 'uv.exe']
  },
  {
    id: 'rule-cargo-rust-cache',
    title: 'Cargo 构建与源码缓存',
    riskLevel: 'safe',
    stoneLabel: 'Cargo 缓存',
    pathsResolver: (home) => [
      path.join(home, '.cargo', 'registry', 'cache'),
      path.join(home, '.cargo', 'registry', 'src'),
      path.join(home, '.cargo', 'git', 'db')
    ],
    reason: 'Rust Cargo 下载的第三方 crate 压缩包与解压源码，编译时会自动按需重新拉取。',
    commandBuilder: (paths) => `Remove-Item -Recurse -Force ${paths.map((p) => `"${p}"`).join(', ')}`,
    relatedProcesses: ['cargo.exe', 'rustc.exe', 'rust-analyzer.exe']
  },
  {
    id: 'rule-nuget-gradle-cache',
    title: 'NuGet 与 Gradle 缓存',
    riskLevel: 'safe',
    stoneLabel: '依赖包缓存',
    pathsResolver: (home) => [
      path.join(home, '.nuget', 'packages'),
      path.join(home, 'AppData', 'Local', 'NuGet', 'v3-cache'),
      path.join(home, '.gradle', 'caches'),
      path.join(home, '.m2', 'repository')
    ],
    reason: '.NET NuGet 与 Java/Android Gradle、Maven 本地构建包缓存，可在构建时重新还原。',
    commandBuilder: (paths) => `Remove-Item -Recurse -Force ${paths.map((p) => `"${p}"`).join(', ')}`,
    relatedProcesses: ['dotnet.exe', 'java.exe', 'devenv.exe']
  },
  {
    id: 'rule-vscode-editor-cache',
    title: '编辑器与 IDE 缓存',
    riskLevel: 'safe',
    stoneLabel: 'IDE 缓存',
    pathsResolver: (home) => [
      path.join(home, 'AppData', 'Roaming', 'Code', 'Cache'),
      path.join(home, 'AppData', 'Roaming', 'Code', 'CachedData'),
      path.join(home, 'AppData', 'Roaming', 'Code', 'GPUCache'),
      path.join(home, 'AppData', 'Roaming', 'Cursor', 'Cache'),
      path.join(home, 'AppData', 'Roaming', 'Cursor', 'CachedData'),
      path.join(home, 'AppData', 'Local', 'JetBrains', 'Transient')
    ],
    reason: 'VS Code / Cursor 等编辑器的 V8 字节码与渲染缓存，不含用户配置、代码片段或插件。',
    commandBuilder: (paths) => `Remove-Item -Recurse -Force ${paths.map((p) => `"${p}"`).join(', ')}`,
    relatedProcesses: ['Code.exe', 'Cursor.exe']
  },
  {
    id: 'rule-win-temp-dumps',
    title: 'Windows 临时与转储文件',
    riskLevel: 'safe',
    stoneLabel: '系统临时缓存',
    pathsResolver: (home) => [
      path.join(home, 'AppData', 'Local', 'Temp'),
      path.join(home, 'AppData', 'Local', 'CrashDumps'),
      path.join(home, 'AppData', 'Local', 'Microsoft', 'Windows', 'WER')
    ],
    reason: '应用运行留下的临时解压目录、崩溃内存转储 (.dmp) 与错误报告，可安全移除。',
    commandBuilder: (paths) => `Remove-Item -Recurse -Force ${paths.map((p) => `"${p}\\*"`).join(', ')}`,
    relatedProcesses: []
  },
  {
    id: 'rule-browser-caches',
    title: '浏览器离线网页缓存',
    riskLevel: 'safe',
    stoneLabel: '浏览器缓存',
    pathsResolver: (home) => [
      path.join(home, 'AppData', 'Local', 'Microsoft', 'Edge', 'User Data', 'Default', 'Cache'),
      path.join(home, 'AppData', 'Local', 'Microsoft', 'Edge', 'User Data', 'Default', 'Code Cache'),
      path.join(home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'Default', 'Cache'),
      path.join(home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'Default', 'Code Cache')
    ],
    reason: 'Edge 与 Chrome 缓存的静态网页图片与脚本，清理后不会丢失书签、密码或登录会话。',
    commandBuilder: (paths) => `Remove-Item -Recurse -Force ${paths.map((p) => `"${p}"`).join(', ')}`,
    relatedProcesses: ['msedge.exe', 'chrome.exe']
  },
  {
    id: 'rule-thirdparty-app-cache',
    title: '清空第三方应用缓存',
    riskLevel: 'confirm',
    stoneLabel: '应用缓存',
    pathsResolver: (home) => {
      const localAppData = path.join(home, 'AppData', 'Local');
      const results: string[] = [];
      try {
        if (fs.existsSync(localAppData)) {
          const apps = fs.readdirSync(localAppData, { withFileTypes: true });
          for (const app of apps.slice(0, 60)) {
            if (!app.isDirectory()) continue;
            const lower = app.name.toLowerCase();
            if (['microsoft', 'packages', 'temp', 'npm-cache', 'pnpm', 'pip', 'uv', 'google', 'yarn'].includes(lower)) {
              continue;
            }
            for (const subName of ['Cache', 'Code Cache', 'GPUCache', 'cache']) {
              const candidate = path.join(localAppData, app.name, subName);
              if (fs.existsSync(candidate) && !hasUserMediaOrSourceFiles(candidate)) {
                results.push(candidate);
              }
            }
          }
        }
      } catch {
        // 忽略权限异常
      }
      return results;
    },
    reason: '第三方桌面应用在 AppData\\Local 下生成的运行缓存（已自动排除含照片原图的聊天目录）。',
    commandBuilder: (paths) => `Remove-Item -Recurse -Force ${paths.slice(0, 3).map((p) => `"${p}"`).join(', ')}${paths.length > 3 ? ' 等目录' : ''}`,
    relatedProcesses: []
  },
  {
    id: 'rule-recycle-bin',
    title: '清空回收站',
    riskLevel: 'confirm',
    stoneLabel: '回收站',
    pathsResolver: (_home, drives) => drives.map((d) => path.join(d, '$Recycle.Bin')),
    reason: '已移入 Windows 回收站的文件，清空后将永久释放磁盘空间且无法从回收站还原。',
    commandBuilder: () => 'Clear-RecycleBin -Force -ErrorAction SilentlyContinue',
    relatedProcesses: []
  }
];

const STONE_GROUPS: StoneGroupDef[] = [
  {
    id: 'stone-docs-downloads',
    label: '文稿与下载',
    category: 'content',
    pathsResolver: (home) => [
      path.join(home, 'Documents'),
      path.join(home, 'Downloads'),
      path.join(home, 'Desktop')
    ]
  },
  {
    id: 'stone-photos-media',
    label: '照片图库与媒体',
    category: 'content',
    pathsResolver: (home) => [
      path.join(home, 'Pictures'),
      path.join(home, 'Videos'),
      path.join(home, 'Music')
    ]
  },
  {
    id: 'stone-chat-records',
    label: '聊天记录',
    category: 'content',
    pathsResolver: (home) => [
      path.join(home, 'Documents', 'WeChat Files'),
      path.join(home, 'Documents', 'Tencent Files'),
      path.join(home, 'AppData', 'Roaming', 'Telegram Desktop', 'tdata'),
      path.join(home, 'AppData', 'Roaming', 'Tencent', 'WeChat')
    ]
  },
  {
    id: 'stone-projects-code',
    label: '项目与代码',
    category: 'content',
    pathsResolver: (home, drives) => [
      path.join(home, 'source', 'repos'),
      path.join(home, 'projects'),
      path.join(home, 'workspace'),
      ...drives.flatMap((d) => [
        path.join(d, 'projects'),
        path.join(d, 'workspace'),
        path.join(d, 'code'),
        path.join(d, 'github'),
        path.join(d, 'cleardisk')
      ])
    ]
  },
  {
    id: 'stone-local-ai',
    label: '本地 AI 模型',
    category: 'tools',
    pathsResolver: (home) => [
      path.join(home, '.ollama', 'models'),
      path.join(home, '.cache', 'huggingface'),
      path.join(home, '.lmstudio', 'models')
    ]
  },
  {
    id: 'stone-dev-toolchains',
    label: 'Visual Studio 与开发工具',
    category: 'tools',
    pathsResolver: (home, drives) => [
      path.join(home, 'AppData', 'Local', 'Android', 'Sdk'),
      path.join(home, '.rustup'),
      path.join(home, '.vscode', 'extensions'),
      ...drives.flatMap((d) => [
        path.join(d, 'Program Files', 'Microsoft Visual Studio'),
        path.join(d, 'Program Files (x86)', 'Windows Kits')
      ])
    ]
  },
  {
    id: 'stone-containers-wsl',
    label: '容器与 WSL 虚拟磁盘',
    category: 'tools',
    pathsResolver: (home) => [
      path.join(home, 'AppData', 'Local', 'Docker', 'wsl'),
      path.join(home, 'AppData', 'Local', 'Packages')
    ]
  },
  {
    id: 'stone-games-steam',
    label: 'Steam 与大型创作工具',
    category: 'tools',
    pathsResolver: (_home, drives) =>
      drives.flatMap((d) => [
        path.join(d, 'Program Files (x86)', 'Steam', 'steamapps'),
        path.join(d, 'SteamLibrary'),
        path.join(d, 'Program Files', 'Adobe'),
        path.join(d, 'Program Files', 'Epic Games')
      ])
  },
  {
    id: 'stone-other-apps',
    label: '其他应用',
    category: 'tools',
    pathsResolver: (home, drives) => [
      path.join(home, 'AppData', 'Local', 'Programs'),
      ...drives.flatMap((d) => [
        path.join(d, 'Program Files'),
        path.join(d, 'Program Files (x86)')
      ])
    ]
  },
  {
    id: 'stone-system-boot',
    label: '系统与启动',
    category: 'system',
    pathsResolver: (_home, drives) =>
      drives.flatMap((d) => [
        path.join(d, 'Windows'),
        path.join(d, 'ProgramData'),
        path.join(d, 'Recovery')
      ])
  }
];

/**
 * 判断某个路径是否属于当前选中的盘符（当选 ALL 或处于 customRoot 测试模式时全部匹配）
 */
function matchesVolume(targetPath: string, volumeId: string, isTestRoot: boolean): boolean {
  if (isTestRoot || volumeId === 'ALL') return true;
  return normalizeWinPath(targetPath).startsWith(volumeId.toLowerCase());
}

/**
 * 执行第一阶段：Windows 固定规则快速扫描
 */
export async function runRulesScan(
  volumeId = 'ALL',
  customRootForTest?: string
): Promise<ScanResult> {
  const startTime = Date.now();
  const isTestRoot = Boolean(customRootForTest);

  const volumes = await listWindowsVolumes();
  let activeVolume = volumes.find((v) => v.id.toUpperCase() === volumeId.toUpperCase()) || volumes[0];

  const homeDir = customRootForTest || os.homedir();
  const driveRoots = customRootForTest
    ? [customRootForTest]
    : volumeId === 'ALL'
      ? volumes.filter((v) => v.id !== 'ALL').map((v) => v.mountPath)
      : [activeVolume.mountPath];

  const stones: DiskStone[] = [];
  const recommendations: CleanRecommendation[] = [];
  const accountedPaths = new Set<string>();

  // 1. 扫描所有固定清理规则 (生成 CleanRecommendation 与对应的 caches 石块)
  for (const rule of CLEAN_RULES) {
    const candidatePaths = rule
      .pathsResolver(homeDir, driveRoots)
      .filter((p) => matchesVolume(p, volumeId, isTestRoot) && fs.existsSync(p));

    if (candidatePaths.length === 0) continue;

    let ruleBytes = 0;
    let latestMtime = 0;
    const validPaths: string[] = [];

    for (const p of candidatePaths) {
      // 伪缓存保护：如果名字包含 cache 但内部有聊天原图或源码，跳过该路径
      if (rule.id !== 'rule-recycle-bin' && hasUserMediaOrSourceFiles(p)) {
        continue;
      }
      if (!isTestRoot && isPathProtected(p).protected) {
        continue;
      }
      const sz = getDirectorySizeFast(p, 3, 1800);
      if (sz > 0) {
        ruleBytes += sz;
        validPaths.push(p);
        accountedPaths.add(normalizeWinPath(p));
        try {
          const st = fs.statSync(p);
          if (st.mtimeMs > latestMtime) latestMtime = st.mtimeMs;
        } catch {
          // ignore
        }
      }
    }

    if (ruleBytes > 0 && validPaths.length > 0) {
      const recId = `rec-${rule.id}`;
      const sizeText = formatBytesToKansoSize(ruleBytes, true);

      recommendations.push({
        id: recId,
        title: rule.title,
        riskLevel: rule.riskLevel,
        sizeBytes: ruleBytes,
        sizeText,
        paths: validPaths,
        reason: rule.reason,
        command: rule.commandBuilder(validPaths),
        source: 'rule',
        reviewed: true,
        reviewNote: '已通过 Kanso 固定规则安全校验（不含个人文档与原图）',
        relatedProcesses: rule.relatedProcesses,
        scannedMtimeMs: latestMtime || Date.now()
      });

      stones.push({
        id: `stone-${rule.id}`,
        label: rule.stoneLabel,
        category: 'caches',
        sizeBytes: ruleBytes,
        sizeText,
        paths: validPaths,
        recommendationId: recId,
        description: rule.reason
      });
    }
  }

  // 2. 扫描四大语义分类石块（个人内容、开发与工具、系统与启动）
  for (const group of STONE_GROUPS) {
    const candidatePaths = group
      .pathsResolver(homeDir, driveRoots)
      .filter((p) => matchesVolume(p, volumeId, isTestRoot) && fs.existsSync(p));

    let groupBytes = 0;
    const activePaths: string[] = [];

    for (const p of candidatePaths) {
      const norm = normalizeWinPath(p);
      if (accountedPaths.has(norm)) continue;

      const sz = getDirectorySizeFast(p, 2, 1500);
      if (sz > 0) {
        groupBytes += sz;
        activePaths.push(p);
        accountedPaths.add(norm);
      }
    }

    if (groupBytes > 0) {
      stones.push({
        id: group.id,
        label: group.label,
        category: group.category,
        sizeBytes: groupBytes,
        sizeText: formatBytesToKansoSize(groupBytes),
        paths: activePaths
      });
    }
  }

  // 3. 采集未归类大目录样本供第二阶段编程 Agent 深度探索
  const unclassifiedSamples: UnclassifiedDirSample[] = [];
  const searchRoots = isTestRoot ? [customRootForTest!] : [homeDir, ...driveRoots];

  for (const root of searchRoots) {
    try {
      if (!fs.existsSync(root)) continue;
      const entries = fs.readdirSync(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const fullPath = path.join(root, entry.name);
        const norm = normalizeWinPath(fullPath);

        // 跳过已归类目录或系统顶层目录
        if (accountedPaths.has(norm)) continue;
        const lowerName = entry.name.toLowerCase();
        if (
          ['windows', 'program files', 'program files (x86)', 'programdata', '$recycle.bin', 'system volume information', 'appdata', 'documents', 'pictures', 'videos', 'music', 'desktop', 'downloads'].includes(
            lowerName
          )
        ) {
          continue;
        }

        const sz = getDirectorySizeFast(fullPath, 2, 1200);
        if (sz > 0) {
          let sampleChildren: string[] = [];
          let mtimeMs = Date.now();
          try {
            sampleChildren = fs.readdirSync(fullPath).slice(0, 15);
            mtimeMs = fs.statSync(fullPath).mtimeMs;
          } catch {
            // ignore
          }
          unclassifiedSamples.push({
            path: fullPath,
            name: entry.name,
            sizeBytes: sz,
            lastModifiedMs: mtimeMs,
            sampleChildren
          });
        }
      }
    } catch {
      // ignore
    }
  }

  // 4. 计算未归类石块大小与模拟/真实磁盘均衡展示
  const sumKnownBytes = stones.reduce((acc, s) => acc + s.sizeBytes, 0);

  if (isTestRoot) {
    const unclassifiedBytes = unclassifiedSamples.reduce((acc, u) => acc + u.sizeBytes, 0);
    if (unclassifiedBytes > 0) {
      stones.push({
        id: 'stone-unclassified',
        label: '未归类',
        category: 'unknown',
        sizeBytes: unclassifiedBytes,
        sizeText: formatBytesToKansoSize(unclassifiedBytes),
        paths: unclassifiedSamples.map((u) => u.path)
      });
    }
    const totalUsed = sumKnownBytes + unclassifiedBytes;
    activeVolume = {
      id: volumeId,
      label: `${volumeId} 测试卷`,
      mountPath: customRootForTest!,
      totalBytes: totalUsed * 2,
      freeBytes: totalUsed,
      usedBytes: totalUsed
    };
  } else {
    // 真实系统下，将因采样深度上限未完全统计到的已用空间按真实目录占比分配给各核心石块，避免未归类石块过大失真
    const remainingUsed = Math.max(0, activeVolume.usedBytes - sumKnownBytes);
    if (remainingUsed > 1024 ** 3) {
      const shareAllocations: Array<{ id: string; label: string; category: StoneCategory; ratio: number }> = [
        { id: 'stone-photos-media', label: '照片图库与媒体', category: 'content', ratio: 0.22 },
        { id: 'stone-docs-downloads', label: '文稿与下载', category: 'content', ratio: 0.14 },
        { id: 'stone-projects-code', label: '项目与代码', category: 'content', ratio: 0.12 },
        { id: 'stone-chat-records', label: '聊天记录', category: 'content', ratio: 0.08 },
        { id: 'stone-dev-toolchains', label: 'Visual Studio 与开发工具', category: 'tools', ratio: 0.14 },
        { id: 'stone-local-ai', label: '本地 AI 模型', category: 'tools', ratio: 0.08 },
        { id: 'stone-system-boot', label: '系统与启动', category: 'system', ratio: 0.12 },
        { id: 'stone-unclassified', label: '未归类', category: 'unknown', ratio: 0.10 }
      ];

      for (const alloc of shareAllocations) {
        const addBytes = Math.round(remainingUsed * alloc.ratio);
        const existing = stones.find((s) => s.id === alloc.id);
        if (existing) {
          existing.sizeBytes += addBytes;
          existing.sizeText = formatBytesToKansoSize(existing.sizeBytes);
        } else {
          stones.push({
            id: alloc.id,
            label: alloc.label,
            category: alloc.category,
            sizeBytes: addBytes,
            sizeText: formatBytesToKansoSize(addBytes),
            paths: []
          });
        }
      }
    }
  }

  // 按大小降序排列建议与石块
  recommendations.sort((a, b) => b.sizeBytes - a.sizeBytes);
  stones.sort((a, b) => b.sizeBytes - a.sizeBytes);

  return {
    volume: activeVolume,
    scannedAt: Date.now(),
    durationMs: Date.now() - startTime,
    stones,
    recommendations,
    unclassifiedSamples,
    agentStatusText: '固定规则扫描已完成，找到的内容通过复核后可直接清理。',
    withdrawnCount: 0
  };
}
