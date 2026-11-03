import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

/**
 * Kanso Windows 版 — 安全边界与受保护路径守卫 (SafetyGuard)
 * 核心准则：
 * 1. Agent 只能只读分析，禁止直接执行写/删操作；
 * 2. 文稿目录、照片图库、桌面、系统核心目录等受保护位置硬编码拒绝删除；
 * 3. 名字叫 Cache 但内部包含用户聊天原图或源码仓库文件的伪缓存目录，拒绝标为可安全清理。
 */

/** 受保护的媒体、文档与源码扩展名集合（用于伪缓存纠偏） */
const PROTECTED_USER_EXTENSIONS = new Set([
  // 照片与原图
  '.jpg', '.jpeg', '.png', '.heic', '.raw', '.cr2', '.nef', '.psd', '.ai', '.fig',
  // 视频与音频创作文件
  '.mp4', '.mov', '.mkv', '.avi', '.wav', '.flac', '.logicx',
  // 用户办公文档
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.pdf', '.md', '.txt',
  // 核心源代码
  '.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go', '.java', '.cs', '.cpp', '.c', '.h'
]);

/**
 * 规范化 Windows 路径为小写且去除末尾斜杠（盘符根除外）
 */
export function normalizeWinPath(inputPath: string): string {
  const resolved = path.resolve(inputPath);
  const lower = resolved.toLowerCase();
  if (/^[a-z]:\\$/.test(lower)) {
    return lower;
  }
  return lower.replace(/\\+$/, '');
}

/**
 * 获取当前系统硬编码受保护的目录黑名单
 */
export function getProtectedRoots(): Array<{ path: string; label: string }> {
  const home = os.homedir();
  const sysDrive = (process.env.SystemDrive || 'C:').toLowerCase();

  return [
    { path: `${sysDrive}\\windows`, label: 'Windows 系统核心目录' },
    { path: `${sysDrive}\\program files`, label: 'Windows 应用程序安装目录' },
    { path: `${sysDrive}\\program files (x86)`, label: 'Windows 32位应用程序目录' },
    { path: normalizeWinPath(home), label: '用户主目录根路径' },
    { path: normalizeWinPath(path.join(home, 'Desktop')), label: '用户桌面目录' },
    { path: normalizeWinPath(path.join(home, 'Documents')), label: '用户文稿目录' },
    { path: normalizeWinPath(path.join(home, 'Pictures')), label: '用户照片图库目录' },
    { path: normalizeWinPath(path.join(home, 'Videos')), label: '用户视频目录' },
    { path: normalizeWinPath(path.join(home, 'Music')), label: '用户音乐目录' },
    { path: normalizeWinPath(path.join(home, 'OneDrive')), label: 'OneDrive 个人云同步目录' }
  ];
}

/**
 * 检查目标路径是否处于受保护黑名单中
 */
export function isPathProtected(targetPath: string): { protected: boolean; reason?: string } {
  if (!targetPath || !targetPath.trim()) {
    return { protected: true, reason: '路径为空' };
  }

  const norm = normalizeWinPath(targetPath);

  // 1. 严禁删除任何盘符根目录（如 C:\, D:\）
  if (/^[a-z]:\\?$/.test(norm)) {
    return { protected: true, reason: `禁止清理磁盘根目录 (${targetPath})` };
  }

  // 2. 检查是否等于受保护根路径，或位于受保护的用户核心内容目录下
  const protectedRoots = getProtectedRoots();
  const homeNorm = normalizeWinPath(os.homedir());

  for (const root of protectedRoots) {
    if (norm === root.path) {
      return { protected: true, reason: `受保护的系统或用户根位置：${root.label}` };
    }
    // 对于除了用户主目录本身之外的受保护目录（如 Documents, Pictures, Windows 等），其子目录也受保护
    if (root.path !== homeNorm && norm.startsWith(root.path + '\\')) {
      return { protected: true, reason: `位于受保护的【${root.label}】内部，Kanso 拒绝清理` };
    }
  }

  // 3. 如果路径存在且为指向受保护区域的符号链接 / 重解析点，予以拒绝
  try {
    if (fs.existsSync(targetPath)) {
      const stat = fs.lstatSync(targetPath);
      if (stat.isSymbolicLink()) {
        const real = fs.realpathSync(targetPath);
        const realNorm = normalizeWinPath(real);
        if (realNorm !== norm) {
          return isPathProtected(real);
        }
      }
    }
  } catch {
    // 忽略读取权限异常
  }

  return { protected: false };
}

/**
 * 扫描目录顶层与二级子项，检测是否包含用户聊天原图、照片、文档或 `.git` 源码仓库
 * 用于实现 Kanso 原版特性：“名字叫 Cache、里面却是聊天原图的目录，会被标为不建议清理”
 */
export function hasUserMediaOrSourceFiles(dirPath: string, maxCheckEntries = 80): boolean {
  try {
    if (!fs.existsSync(dirPath)) {
      return false;
    }

    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    let checked = 0;

    for (const entry of entries) {
      if (checked++ >= maxCheckEntries) break;

      if (entry.name === '.git' || entry.name === '.svn') {
        return true;
      }

      if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (PROTECTED_USER_EXTENSIONS.has(ext)) {
          return true;
        }
      } else if (entry.isDirectory()) {
        // 抽样检查一级子目录
        const subDir = path.join(dirPath, entry.name);
        try {
          const subEntries = fs.readdirSync(subDir, { withFileTypes: true });
          for (let i = 0; i < Math.min(subEntries.length, 15); i++) {
            const sub = subEntries[i];
            if (sub.name === '.git') return true;
            if (sub.isFile() && PROTECTED_USER_EXTENSIONS.has(path.extname(sub.name).toLowerCase())) {
              return true;
            }
          }
        } catch {
          // 跳过无权限子目录
        }
      }
    }
  } catch {
    return false;
  }

  return false;
}

/**
 * 清理前双重验证目标路径：
 * 1. 不能命中受保护黑名单
 * 2. 必须位于已通过复核且经用户勾选确认的规范化路径集合中
 */
export function validateCleanTarget(
  targetPath: string,
  approvedNormalizedPaths: Set<string>
): { valid: boolean; reason?: string } {
  const protection = isPathProtected(targetPath);
  if (protection.protected) {
    return { valid: false, reason: protection.reason };
  }

  const norm = normalizeWinPath(targetPath);
  if (!approvedNormalizedPaths.has(norm)) {
    return {
      valid: false,
      reason: `路径未在用户确认及复核通过清单中 (${targetPath})`
    };
  }

  return { valid: true };
}

/**
 * 将字节数格式化为 Kanso 规范的 GB 显示字符串
 * 例如：196 GB -> "196 G"，14.5 GB -> "14.5 G"
 */
export function formatBytesToKansoSize(bytes: number, forceOneDecimal = false): string {
  const gb = Math.max(0, bytes) / (1024 ** 3);
  if (gb >= 100 && !forceOneDecimal) {
    return `${Math.round(gb)} G`;
  }
  if (gb >= 10) {
    const rounded = Math.round(gb * 10) / 10;
    if (Number.isInteger(rounded) && !forceOneDecimal) {
      return `${rounded} G`;
    }
    return `${rounded.toFixed(1)} G`;
  }
  return `${gb.toFixed(1)} G`;
}

