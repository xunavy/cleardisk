import { describe, it, expect } from 'vitest';
import { computeKansoGardenLayout } from '../src/renderer/voronoi-garden';
import { DiskStone } from '../src/shared/types';

describe('VoronoiGarden 枯山水加权 Voronoi 石块与同心砂纹几何引擎测试', () => {
  const sampleStones: DiskStone[] = [
    {
      id: 'stone-photos',
      label: '照片图库',
      category: 'content',
      sizeBytes: 188 * 1024 ** 3,
      sizeText: '188 G',
      paths: ['C:\\Users\\test\\Pictures']
    },
    {
      id: 'stone-docs',
      label: '文稿与下载',
      category: 'content',
      sizeBytes: 74 * 1024 ** 3,
      sizeText: '74.0 G',
      paths: ['C:\\Users\\test\\Documents']
    },
    {
      id: 'stone-chat',
      label: '聊天记录',
      category: 'content',
      sizeBytes: 52 * 1024 ** 3,
      sizeText: '52.0 G',
      paths: ['C:\\Users\\test\\Documents\\WeChat Files']
    },
    {
      id: 'stone-code',
      label: '项目与代码',
      category: 'content',
      sizeBytes: 41 * 1024 ** 3,
      sizeText: '41.0 G',
      paths: ['D:\\projects']
    },
    {
      id: 'stone-ai',
      label: '本地 AI 模型',
      category: 'tools',
      sizeBytes: 44 * 1024 ** 3,
      sizeText: '44.0 G',
      paths: ['C:\\Users\\test\\.ollama']
    },
    {
      id: 'stone-vs',
      label: 'Visual Studio 与开发',
      category: 'tools',
      sizeBytes: 58 * 1024 ** 3,
      sizeText: '58.0 G',
      paths: ['C:\\Program Files\\Microsoft Visual Studio']
    },
    {
      id: 'stone-npm',
      label: 'npm 缓存',
      category: 'caches',
      sizeBytes: 14.5 * 1024 ** 3,
      sizeText: '14.5 G',
      paths: ['C:\\Users\\test\\AppData\\Local\\npm-cache'],
      recommendationId: 'rec-npm'
    },
    {
      id: 'stone-pnpm',
      label: 'pnpm store',
      category: 'caches',
      sizeBytes: 6.8 * 1024 ** 3,
      sizeText: '6.8 G',
      paths: ['C:\\Users\\test\\AppData\\Local\\pnpm\\store'],
      recommendationId: 'rec-pnpm'
    },
    {
      id: 'stone-system',
      label: '系统与启动',
      category: 'system',
      sizeBytes: 39 * 1024 ** 3,
      sizeText: '39.0 G',
      paths: ['C:\\Windows']
    },
    {
      id: 'stone-unknown',
      label: '未归类',
      category: 'unknown',
      sizeBytes: 31 * 1024 ** 3,
      sizeText: '31.0 G',
      paths: []
    }
  ];

  it('生成包含二次贝塞尔圆角指令 (Q) 的石块路径与多层可用空间同心砂纹', () => {
    const layout = computeKansoGardenLayout({
      width: 1440,
      height: 900,
      freeBytes: 196 * 1024 ** 3,
      stones: sampleStones,
      selectedRecIds: new Set(['rec-npm'])
    });

    expect(layout.width).toBe(1440);
    expect(layout.height).toBe(900);
    expect(layout.freeSpaceRingsPath).toContain('M');
    expect(layout.freeSpaceRingsPath).toContain('Q');
    expect(layout.freeSpaceRingsPath).toContain('Z');
    expect(layout.stones.length).toBeGreaterThanOrEqual(8);

    for (const st of layout.stones) {
      expect(st.shapePath).toMatch(/^M[\d.\s,QLZ-]+Z$/);
      expect(st.shapePath).toContain('Q');
    }
  });

  it('当某个可清理缓存被勾选时，对应石块自动变为镂空状态 (isHole=true) 并生成内部同心砂纹', () => {
    const layout = computeKansoGardenLayout({
      width: 1440,
      height: 900,
      freeBytes: 196 * 1024 ** 3,
      stones: sampleStones,
      selectedRecIds: new Set(['rec-npm'])
    });

    const npmStone = layout.stones.find((s) => s.recommendationId === 'rec-npm');
    const pnpmStone = layout.stones.find((s) => s.recommendationId === 'rec-pnpm');

    expect(npmStone).toBeDefined();
    expect(npmStone!.isHole).toBe(true);
    expect(npmStone!.ringsPath.length).toBeGreaterThan(20);
    expect(npmStone!.ringsPath).toContain('Q');

    expect(pnpmStone).toBeDefined();
    expect(pnpmStone!.isHole).toBe(false);
  });

  it('确保没有任何石块的质心侵入左上角控制面板留白区域 (x < 460 && y < 600)', () => {
    const layout = computeKansoGardenLayout({
      width: 1440,
      height: 900,
      freeBytes: 196 * 1024 ** 3,
      stones: sampleStones,
      selectedRecIds: new Set()
    });

    for (const st of layout.stones) {
      const inControlPanel = st.labelX < 460 && st.labelY < 600;
      expect(inControlPanel).toBe(false);
    }
  });
});

