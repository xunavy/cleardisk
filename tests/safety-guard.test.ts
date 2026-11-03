import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import {
  isPathProtected,
  hasUserMediaOrSourceFiles,
  validateCleanTarget,
  formatBytesToKansoSize
} from '../src/core/safety/safety-guard';

describe('SafetyGuard 安全沙盒与受保护路径黑名单测试', () => {
  it('必须拦截盘符根目录与 Windows 系统核心目录', () => {
    expect(isPathProtected('C:\\').protected).toBe(true);
    expect(isPathProtected('D:\\').protected).toBe(true);
    expect(isPathProtected('C:\\Windows').protected).toBe(true);
    expect(isPathProtected('C:\\Windows\\System32\\drivers').protected).toBe(true);
    expect(isPathProtected('C:\\Program Files').protected).toBe(true);
  });

  it('必须拦截用户桌面、文稿、相册、视频与微信聊天主体目录', () => {
    const home = os.homedir();
    expect(isPathProtected(path.join(home, 'Documents')).protected).toBe(true);
    expect(isPathProtected(path.join(home, 'Documents', 'WeChat Files')).protected).toBe(true);
    expect(isPathProtected(path.join(home, 'Pictures', 'Camera Roll')).protected).toBe(true);
    expect(isPathProtected(path.join(home, 'Desktop')).protected).toBe(true);
    expect(isPathProtected(path.join(home, 'Videos')).protected).toBe(true);
  });

  it('允许合法的缓存目录通过黑名单校验，但必须位于已确认集合中', () => {
    const npmCache = path.join(os.homedir(), 'AppData', 'Local', 'npm-cache');
    expect(isPathProtected(npmCache).protected).toBe(false);

    const approved = new Set([path.resolve(npmCache).toLowerCase()]);
    expect(validateCleanTarget(npmCache, approved).valid).toBe(true);
    expect(validateCleanTarget('C:\\Unapproved\\Cache', approved).valid).toBe(false);
    expect(validateCleanTarget('C:\\Windows\\System32', approved).valid).toBe(false);
  });

  it('能够识别名字叫 Cache 但内含聊天原图或源码的伪缓存目录（防止误删）', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kanso-safety-test-'));
    try {
      const fakePhotoCache = path.join(tmpRoot, 'WeChat_Image_Cache');
      fs.mkdirSync(fakePhotoCache, { recursive: true });
      fs.writeFileSync(path.join(fakePhotoCache, 'family_photo_2026.jpg'), Buffer.alloc(2048));
      expect(hasUserMediaOrSourceFiles(fakePhotoCache)).toBe(true);

      const pureTechCache = path.join(tmpRoot, 'npm_cacache');
      fs.mkdirSync(pureTechCache, { recursive: true });
      fs.writeFileSync(path.join(pureTechCache, 'index-v5.bin'), Buffer.alloc(1024));
      expect(hasUserMediaOrSourceFiles(pureTechCache)).toBe(false);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('正确格式化字节数为 Kanso 风格容量文本', () => {
    expect(formatBytesToKansoSize(196 * 1024 ** 3)).toBe('196 G');
    expect(formatBytesToKansoSize(14.5 * 1024 ** 3)).toBe('14.5 G');
    expect(formatBytesToKansoSize(512 * 1024 ** 2)).toBe('0.5 G');
  });
});

