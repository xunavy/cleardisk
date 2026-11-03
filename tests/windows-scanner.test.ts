import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import {
  listWindowsVolumes,
  getDirectorySizeFast,
  runRulesScan
} from '../src/core/scanner/windows-rules';

describe('WindowsRulesScanner 多盘符探测与固定规则扫描引擎测试', () => {
  it('能够探测本机真实 Windows 逻辑盘符及全盘汇总容量', async () => {
    const volumes = await listWindowsVolumes();
    expect(volumes.length).toBeGreaterThanOrEqual(2); // 至少包含 1 个盘符 + ALL 汇总
    const allVol = volumes.find((v) => v.id === 'ALL');
    expect(allVol).toBeDefined();
    expect(allVol!.totalBytes).toBeGreaterThan(0);
    expect(allVol!.freeBytes).toBeGreaterThan(0);
  });

  it('能够快速递归计算目录真实字节大小', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kanso-size-test-'));
    try {
      const subDir = path.join(tmpRoot, 'sub');
      fs.mkdirSync(subDir, { recursive: true });
      fs.writeFileSync(path.join(tmpRoot, 'a.bin'), Buffer.alloc(4096));
      fs.writeFileSync(path.join(subDir, 'b.bin'), Buffer.alloc(8192));

      const size = getDirectorySizeFast(tmpRoot);
      expect(size).toBe(12288);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('能够针对模拟环境执行 Windows 固定规则扫描并生成石块与清理建议', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kanso-scan-mock-'));
    try {
      // 构造模拟的用户缓存、开发工具、个人内容和未归类目录
      const npmCache = path.join(tmpRoot, 'AppData', 'Local', 'npm-cache');
      const pnpmStore = path.join(tmpRoot, 'AppData', 'Local', 'pnpm', 'store');
      const docsDir = path.join(tmpRoot, 'Documents');
      const photosDir = path.join(tmpRoot, 'Pictures');
      const ollamaDir = path.join(tmpRoot, '.ollama', 'models');
      const recycleBin = path.join(tmpRoot, '$Recycle.Bin');
      const mysteryDir = path.join(tmpRoot, 'MysteryWorkspace');

      for (const d of [npmCache, pnpmStore, docsDir, photosDir, ollamaDir, recycleBin, mysteryDir]) {
        fs.mkdirSync(d, { recursive: true });
      }

      // 写入测试文件
      fs.writeFileSync(path.join(npmCache, 'pkg.tgz'), Buffer.alloc(1024 * 600));
      fs.writeFileSync(path.join(pnpmStore, 'blob.bin'), Buffer.alloc(1024 * 500));
      fs.writeFileSync(path.join(docsDir, 'report.docx'), Buffer.alloc(1024 * 800));
      fs.writeFileSync(path.join(photosDir, 'img.jpg'), Buffer.alloc(1024 * 900));
      fs.writeFileSync(path.join(ollamaDir, 'llama.gguf'), Buffer.alloc(1024 * 700));
      fs.writeFileSync(path.join(recycleBin, 'trash.dat'), Buffer.alloc(1024 * 400));
      fs.writeFileSync(path.join(mysteryDir, 'unknown.dat'), Buffer.alloc(1024 * 650));

      const result = await runRulesScan('C:', tmpRoot);

      expect(result.stones.length).toBeGreaterThanOrEqual(4);
      expect(result.recommendations.length).toBeGreaterThanOrEqual(2);

      // 检查是否识别出 npm 缓存为 safe（可安全清理）
      const npmRec = result.recommendations.find((r) => r.title.includes('npm'));
      expect(npmRec).toBeDefined();
      expect(npmRec!.riskLevel).toBe('safe');
      expect(npmRec!.reason.length).toBeGreaterThan(5);
      expect(npmRec!.command.length).toBeGreaterThan(5);

      // 检查是否识别出回收站为 confirm（确认后清理）
      const recycleRec = result.recommendations.find((r) => r.title.includes('回收站'));
      expect(recycleRec).toBeDefined();
      expect(recycleRec!.riskLevel).toBe('confirm');

      // 检查是否采集了未归类目录样本供 Agent 探索
      expect(result.unclassifiedSamples.some((s) => s.name === 'MysteryWorkspace')).toBe(true);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

