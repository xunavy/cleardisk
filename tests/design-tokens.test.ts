import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('Kanso 设计令牌与桌面界面结构一致性测试', () => {
  const cssPath = path.resolve(__dirname, '../src/renderer/styles.css');
  const htmlPath = path.resolve(__dirname, '../src/renderer/index.html');

  it('styles.css 必须完整包含原版 Kanso 浅色与深色色彩令牌及 .stone.hole / .rings 规则', () => {
    expect(fs.existsSync(cssPath)).toBe(true);
    const css = fs.readFileSync(cssPath, 'utf-8');

    // 浅色令牌
    expect(css).toContain('--ground: #efebe1');
    expect(css).toContain('--ink: #2a2926');
    expect(css).toContain('--on-ink: #f4f1e9');
    expect(css).toContain('--rake: #cfc9ba');
    expect(css).toContain('--s-content: #2a2926');
    expect(css).toContain('--s-tools: #75726a');
    expect(css).toContain('--s-caches: #d3cec0');
    expect(css).toContain('--s-system: #e3ded2');

    // 深色令牌
    expect(css).toContain('#1a1916');
    expect(css).toContain('#e8e3d7');

    // 枯山水石块与镂空砂纹样式类
    expect(css).toContain('.rings');
    expect(css).toContain('.stone.hole');
    expect(css).toContain('.f-content');
    expect(css).toContain('.f-tools');
    expect(css).toContain('.f-caches');
    expect(css).toContain('.f-system');
    expect(css).toContain('.f-unknown');
  });

  it('index.html 必须包含左上角控制面板、盘符选择器、重新扫描、工作记录、设置及双模式清理按钮', () => {
    expect(fs.existsSync(htmlPath)).toBe(true);
    const html = fs.readFileSync(htmlPath, 'utf-8');

    expect(html).toContain('重新扫描');
    expect(html).toContain('工作记录');
    expect(html).toContain('设置');
    expect(html).toContain('可安全清理');
    expect(html).toContain('确认后清理');
    expect(html).toContain('直接清理');
  });
});

