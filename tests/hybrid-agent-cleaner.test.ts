import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { runRulesScan } from '../src/core/scanner/windows-rules';
import { runAgentExplorationAndReview } from '../src/core/agent/hybrid-agent';
import { executeClean } from '../src/core/cleaner/cleaner-engine';
import { AppSettings, CleanRecommendation } from '../src/shared/types';

const defaultTestSettings: AppSettings = {
  theme: 'light',
  agentBackend: 'heuristic',
  llmApiEndpoint: '',
  llmApiKey: '',
  llmModel: '',
  deleteMethod: 'permanent',
  excludedPaths: []
};

describe('HybridAgent 探索复核与 CleanerEngine 双模式安全清理测试', () => {
  it('探索 Agent 能发现旧项目依赖 (node_modules/target)，同时复核 Agent 会撤回含聊天原图的伪缓存建议', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kanso-agent-test-'));
    try {
      // 1. 构造一个未归类旧项目，内含 node_modules
      const oldProjectNodeModules = path.join(tmpRoot, 'OldAppProject', 'node_modules');
      fs.mkdirSync(oldProjectNodeModules, { recursive: true });
      fs.writeFileSync(path.join(oldProjectNodeModules, 'bundle.js'), Buffer.alloc(1024 * 500));

      // 2. 构造一个伪缓存目录（名为 WeChatCache，但里面有用户照片 .jpg）
      const fakeCacheDir = path.join(tmpRoot, 'WeChatCache');
      fs.mkdirSync(fakeCacheDir, { recursive: true });
      fs.writeFileSync(path.join(fakeCacheDir, 'chat_original_photo.jpg'), Buffer.alloc(1024 * 400));

      const baseScan = await runRulesScan('C:', tmpRoot);

      // 人为塞入一条错误的伪缓存建议，测试独立复核 Agent 是否会将其撤回
      const badRec: CleanRecommendation = {
        id: 'rec-fake-wechat-cache',
        title: '伪装成缓存的聊天原图目录',
        riskLevel: 'safe',
        sizeBytes: 400 * 1024,
        sizeText: '0.1 G',
        paths: [fakeCacheDir],
        reason: '错误判断为普通缓存',
        command: `Remove-Item "${fakeCacheDir}"`,
        source: 'rule',
        reviewed: false
      };
      baseScan.recommendations.push(badRec);

      const { updatedResult, logs } = await runAgentExplorationAndReview(baseScan, defaultTestSettings);

      // 验证探索 Agent 发现了 OldAppProject/node_modules
      const foundNodeModules = updatedResult.recommendations.find((r) =>
        r.paths.some((p) => p.includes('node_modules'))
      );
      expect(foundNodeModules).toBeDefined();
      expect(foundNodeModules!.reviewed).toBe(true);

      // 验证独立复核 Agent 撤回了含聊天原图的伪缓存建议
      const stillHasBadRec = updatedResult.recommendations.some((r) => r.id === 'rec-fake-wechat-cache');
      expect(stillHasBadRec).toBe(false);
      expect(updatedResult.withdrawnCount).toBeGreaterThanOrEqual(1);
      expect(logs.length).toBeGreaterThanOrEqual(2);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('CleanerEngine 仅清理用户显式勾选的建议，且支持直接清理与让 Agent 清理（含空间复测）', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kanso-clean-test-'));
    try {
      const cacheA = path.join(tmpRoot, 'cache-a');
      const cacheB = path.join(tmpRoot, 'cache-b');
      fs.mkdirSync(cacheA, { recursive: true });
      fs.mkdirSync(cacheB, { recursive: true });
      fs.writeFileSync(path.join(cacheA, 'data.bin'), Buffer.alloc(1024 * 256));
      fs.writeFileSync(path.join(cacheB, 'data.bin'), Buffer.alloc(1024 * 256));

      const statA = fs.statSync(cacheA);
      const statB = fs.statSync(cacheB);

      const recs: CleanRecommendation[] = [
        {
          id: 'rec-a',
          title: '测试缓存 A',
          riskLevel: 'safe',
          sizeBytes: 256 * 1024,
          sizeText: '0.1 G',
          paths: [cacheA],
          reason: '可重建测试缓存 A',
          command: `Remove-Item "${cacheA}"`,
          source: 'rule',
          reviewed: true,
          scannedMtimeMs: statA.mtimeMs
        },
        {
          id: 'rec-b',
          title: '测试缓存 B（未勾选）',
          riskLevel: 'safe',
          sizeBytes: 256 * 1024,
          sizeText: '0.1 G',
          paths: [cacheB],
          reason: '可重建测试缓存 B',
          command: `Remove-Item "${cacheB}"`,
          source: 'rule',
          reviewed: true,
          scannedMtimeMs: statB.mtimeMs
        }
      ];

      // 仅勾选 rec-a，使用 agent 模式清理
      const cleanRes = await executeClean(recs, ['rec-a'], 'agent', defaultTestSettings);

      expect(cleanRes.success).toBe(true);
      expect(cleanRes.cleanedIds).toEqual(['rec-a']);
      expect(cleanRes.actualFreedBytes).toBeGreaterThanOrEqual(256 * 1024);

      // cacheA 已被清理，而未勾选的 cacheB 必须完好无损
      expect(fs.existsSync(cacheA)).toBe(false);
      expect(fs.existsSync(cacheB)).toBe(true);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
