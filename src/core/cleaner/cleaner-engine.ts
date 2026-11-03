import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  AppSettings,
  CleanExecutionResult,
  CleanMode,
  CleanRecommendation,
  WorkLogEntry
} from '../../shared/types';
import {
  formatBytesToKansoSize,
  normalizeWinPath,
  validateCleanTarget
} from '../safety/safety-guard';
import { getDirectorySizeFast } from '../scanner/windows-rules';

const execFileAsync = promisify(execFile);

/**
 * 获取当前 Windows 正在运行的进程名集合（小写）
 * 用于“让 Agent 清理”模式前检查关联应用是否正在运行
 */
async function getRunningWindowsProcesses(): Promise<Set<string>> {
  const running = new Set<string>();
  try {
    const { stdout } = await execFileAsync('tasklist.exe', ['/FO', 'CSV', '/NH'], {
      timeout: 4000,
      windowsHide: true
    });
    const lines = stdout.split(/\r?\n/);
    for (const line of lines) {
      const match = /^"([^"]+)"/.exec(line.trim());
      if (match && match[1]) {
        running.add(match[1].toLowerCase());
      }
    }
  } catch {
    // 忽略命令失败
  }
  return running;
}

/**
 * 将指定目录移入 Windows 回收站（使用 PowerShell VisualBasic FileSystem API）
 */
async function movePathToWindowsRecycleBin(targetPath: string): Promise<boolean> {
  const escaped = targetPath.replace(/'/g, "''");
  const psScript = `
    Add-Type -AssemblyName Microsoft.VisualBasic
    if (Test-Path -LiteralPath '${escaped}') {
      $item = Get-Item -LiteralPath '${escaped}' -Force
      if ($item.PSIsContainer) {
        [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory('${escaped}', 'OnlyErrorDialogs', 'SendToRecycleBin')
      } else {
        [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('${escaped}', 'OnlyErrorDialogs', 'SendToRecycleBin')
      }
    }
  `;
  try {
    await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', psScript],
      { timeout: 15000, windowsHide: true }
    );
    return !fs.existsSync(targetPath);
  } catch {
    return false;
  }
}

/**
 * 容错永久清理目标目录或文件（对被锁定的单个临时文件自动跳过并继续清理其余文件）
 */
function deletePathPermanentlyFaultTolerant(targetPath: string): void {
  if (!fs.existsSync(targetPath)) return;

  try {
    fs.rmSync(targetPath, { recursive: true, force: true });
    return;
  } catch {
    // 如果顶层目录因内部个别文件被占用无法整体删除，则逐项递归清理可删子文件
  }

  try {
    const entries = fs.readdirSync(targetPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(targetPath, entry.name);
      try {
        fs.rmSync(fullPath, { recursive: true, force: true });
      } catch {
        // 跳过正在被系统占用的单个文件
      }
    }
  } catch {
    // ignore
  }
}

/**
 * 读取指定路径所在驱动器的当前可用空间（字节）
 */
function getVolumeFreeBytesForPath(samplePath: string): number {
  try {
    const root = path.parse(path.resolve(samplePath)).root || 'C:\\';
    const st = fs.statfsSync(root);
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return 0;
  }
}

/**
 * 执行双模式清理：
 * - mode = 'direct'：直接清理用户勾选的条目，内容与复核时完全一致
 * - mode = 'agent'：让 Agent 清理（先校验路径一致与相关进程未运行，逐项通过 Kanso 执行，再重新测量实际释放空间）
 */
export async function executeClean(
  recommendations: CleanRecommendation[],
  selectedIds: string[],
  mode: CleanMode,
  settings: AppSettings
): Promise<CleanExecutionResult> {
  const selectedSet = new Set(selectedIds);
  const targetRecs = recommendations.filter((r) => selectedSet.has(r.id) && r.reviewed);

  // 构建已确认安全路径白名单集合
  const approvedNormalizedPaths = new Set<string>(
    targetRecs.flatMap((r) => r.paths.map((p) => normalizeWinPath(p)))
  );

  const firstPath = targetRecs[0]?.paths[0] || 'C:\\';
  const freeBytesBefore = getVolumeFreeBytesForPath(firstPath);

  const runningProcesses =
    mode === 'agent' ? await getRunningWindowsProcesses() : new Set<string>();

  const cleanedIds: string[] = [];
  const skippedItems: Array<{ id: string; title: string; reason: string }> = [];
  const logs: WorkLogEntry[] = [];
  let measuredFreedBytes = 0;

  for (const rec of targetRecs) {
    // 1. 若是“让 Agent 清理”模式，先检查关联宿主应用是否正在运行
    if (mode === 'agent' && rec.relatedProcesses && rec.relatedProcesses.length > 0) {
      const activeProc = rec.relatedProcesses.find((p) => runningProcesses.has(p.toLowerCase()));
      if (activeProc) {
        const reason = `关联应用 (${activeProc}) 正在运行，为防止运行时缓存冲突，Agent 已安全跳过该项。`;
        skippedItems.push({ id: rec.id, title: rec.title, reason });
        logs.push({
          id: `log-skip-proc-${Date.now()}-${rec.id}`,
          timestamp: Date.now(),
          type: 'clean-agent',
          title: `跳过正在运行的应用缓存：${rec.title}`,
          detail: reason,
          paths: rec.paths
        });
        continue;
      }
    }

    let recFreedBytes = 0;
    let recCleanedAny = false;
    let skipReason = '';

    for (const targetPath of rec.paths) {
      // 2. 通过 SafetyGuard 校验受保护黑名单与确认白名单
      const validation = validateCleanTarget(targetPath, approvedNormalizedPaths);
      if (!validation.valid) {
        skipReason = validation.reason || '未通过安全边界校验';
        continue;
      }

      if (!fs.existsSync(targetPath)) {
        continue;
      }

      // 2.5 若是“让 Agent 清理”模式，复验目录修改时间戳自扫描完成以来未被外部大幅篡改
      if (mode === 'agent' && rec.scannedMtimeMs) {
        try {
          const curStat = fs.statSync(targetPath);
          if (curStat.mtimeMs - rec.scannedMtimeMs > 60_000) {
            skipReason = `目录在扫描完成后发生过外部写入修改 (${targetPath})，Agent 为安全起见已跳过，请重新扫描确认。`;
            continue;
          }
        } catch {
          // ignore stat error
        }
      }

      // 3. 测量清理前目录真实大小
      const beforeDirBytes = getDirectorySizeFast(targetPath, 5, 20000);

      // 4. 执行清理（移至回收站或永久删除）
      if (rec.id === 'rec-rule-recycle-bin' || targetPath.toLowerCase().includes('$recycle.bin')) {
        try {
          await execFileAsync(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-Command', 'Clear-RecycleBin -Force -ErrorAction SilentlyContinue'],
            { timeout: 15000, windowsHide: true }
          );
        } catch {
          deletePathPermanentlyFaultTolerant(targetPath);
        }
      } else if (settings.deleteMethod === 'recycle') {
        const moved = await movePathToWindowsRecycleBin(targetPath);
        if (!moved && rec.riskLevel === 'safe') {
          // 仅对可安全重建的纯缓存目录在整体移入回收站受阻时按文件粒度容错清理未锁定缓存
          deletePathPermanentlyFaultTolerant(targetPath);
        }
      } else {
        deletePathPermanentlyFaultTolerant(targetPath);
      }

      // 5. 重新测量清理后剩余大小，计算实际释放量
      const afterDirBytes = fs.existsSync(targetPath)
        ? getDirectorySizeFast(targetPath, 5, 20000)
        : 0;
      const freed = Math.max(0, beforeDirBytes - afterDirBytes);
      recFreedBytes += freed;
      recCleanedAny = true;
    }

    if (recCleanedAny) {
      cleanedIds.push(rec.id);
      measuredFreedBytes += recFreedBytes;
      logs.push({
        id: `log-clean-${Date.now()}-${rec.id}`,
        timestamp: Date.now(),
        type: mode === 'agent' ? 'clean-agent' : 'clean-direct',
        title: `${mode === 'agent' ? 'Agent 协同清理' : '直接清理'}完成：${rec.title}`,
        detail: `已清理 ${rec.paths.join(', ')}，实际释放 ${formatBytesToKansoSize(recFreedBytes, true)}。`,
        paths: rec.paths,
        freedBytes: recFreedBytes
      });
    } else if (skipReason) {
      skippedItems.push({ id: rec.id, title: rec.title, reason: skipReason });
    }
  }

  const freeBytesAfter = Math.max(freeBytesBefore + measuredFreedBytes, getVolumeFreeBytesForPath(firstPath));
  const actualFreedText = formatBytesToKansoSize(measuredFreedBytes, true);

  const summaryText =
    mode === 'agent'
      ? `Agent 已完成路径复验与逐项清理：共清理 ${cleanedIds.length} 项，实际释放 ${actualFreedText}${
          skippedItems.length > 0 ? `（${skippedItems.length} 项因应用运行中未动）` : ''
        }。`
      : `直接清理完成：已执行您确认勾选的 ${cleanedIds.length} 项建议，释放 ${actualFreedText}。`;

  return {
    success: true,
    mode,
    cleanedIds,
    skippedItems,
    freeBytesBefore,
    freeBytesAfter,
    actualFreedBytes: measuredFreedBytes,
    actualFreedText,
    summaryText,
    logs
  };
}

