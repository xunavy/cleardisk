# Kanso Windows 版磁盘清理工具实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个 1:1 复刻 macOS Kanso 枯山水视觉与“固定规则 + 编程 Agent 探索 + 独立 Agent 复核 + 双模式安全清理”机制的 Windows 桌面应用。

**Architecture:** 采用 Electron + TypeScript 全栈架构，底层通过安全边界守卫 (`SafetyGuard`)、Windows 多盘符固定规则扫描引擎 (`WindowsRulesScanner`)、混合探索与独立复核协调器 (`HybridAgentCoordinator`) 以及双模式清理执行器 (`CleanerEngine`) 驱动数据流；渲染层通过自包含的加权 Voronoi 半平面裁剪与二次贝塞尔圆角/同心砂纹几何引擎 (`VoronoiGarden`) 动态绘制枯山水庭院占用图，并与左上角控制面板实时联动。

**Architecture Diagram:**

![Kanso Windows 版实施计划任务分解与模块依赖图](file:///C:/Users/navy/.gemini/antigravity/brain/7dfd1351-250d-4ea5-a5eb-be42e0293d86/kanso_windows_plan_graph.png)

**Tech Stack:** Node.js `v24+`, Electron `^35.0.0`, TypeScript `^5.8.0`, Vitest `^3.0.0`

**Spec:** [`docs/superpowers/specs/2026-11-03-kanso-windows-design.md`](file:///d:/cleardisk/docs/superpowers/specs/2026-11-03-kanso-windows-design.md)

## Global Constraints

- 操作系统要求：Windows 10 / 11，支持多盘符（`C:`, `D:` 等及 `ALL` 全盘汇总视图）。
- 语言与文案要求：所有界面文案、代码注释、日志及提交信息均使用简体中文；保留必要技术术语（如 `npm`, `Agent`, `Voronoi`, `IPC`）。
- 安全红线：严禁替用户默认自动勾选任何待清理项；严禁删除受保护黑名单路径（`C:\Windows\System32`、桌面、文稿、相册、含聊天原图的伪缓存目录、含 `.git` 的项目源码文件）；Agent 仅具只读分析权限。
- 视觉规范：严格使用原版 Kanso CSS 令牌（`--ground: #efebe1`, `--ink: #2a2926`, `--rake: #cfc9ba` 及深色模式对应令牌），无卡片、无阴影、单实心主按钮，勾选待清理项时对应石块实时变为 `.stone.hole` 镂空同心砂纹。

---

### Task 1: 项目脚手架、共享类型契约与安全沙盒守卫 (`SafetyGuard`)

**Files:**
- Create: `d:\cleardisk\package.json`
- Create: `d:\cleardisk\tsconfig.json`
- Create: `d:\cleardisk\src\shared\types.ts`
- Create: `d:\cleardisk\src\core\safety\safety-guard.ts`
- Test: `d:\cleardisk\tests\safety-guard.test.ts`

**Interfaces:**
- Consumes: Node.js `path`, `fs`, `os`
- Produces:
  - `src/shared/types.ts`: `StoneCategory`, `CleanRiskLevel`, `DiskVolume`, `DiskStone`, `CleanRecommendation`, `ScanResult`, `CleanMode`, `CleanDeleteMethod`, `AgentBackendType`, `AppSettings`, `WorkLogEntry`, `CleanExecutionResult`
  - `src/core/safety/safety-guard.ts`: `isPathProtected(targetPath: string): { protected: boolean; reason?: string }`, `hasUserMediaOrSourceFiles(dirPath: string): boolean`, `validateCleanTarget(targetPath: string, approvedPaths: Set<string>): { valid: boolean; reason?: string }`

- [ ] **Step 1: 创建项目配置文件与共享类型定义，并编写失败的安全守卫单元测试**

创建 `package.json`, `tsconfig.json`, `src/shared/types.ts`，并在 `tests/safety-guard.test.ts` 中编写针对系统目录、用户文稿/图片目录、盘符根目录、未授权路径以及含聊天原图/源码的伪缓存目录拦截测试：

```typescript
// tests/safety-guard.test.ts
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { isPathProtected, hasUserMediaOrSourceFiles, validateCleanTarget } from '../src/core/safety/safety-guard';

describe('SafetyGuard 安全沙盒与受保护路径黑名单测试', () => {
  it('必须拦截盘符根目录与 Windows 系统核心目录', () => {
    expect(isPathProtected('C:\\').protected).toBe(true);
    expect(isPathProtected('D:\\').protected).toBe(true);
    expect(isPathProtected('C:\\Windows').protected).toBe(true);
    expect(isPathProtected('C:\\Windows\\System32\\drivers').protected).toBe(true);
  });

  it('必须拦截用户桌面、文稿、图片等受保护个人内容目录', () => {
    const home = os.homedir();
    expect(isPathProtected(path.join(home, 'Documents')).protected).toBe(true);
    expect(isPathProtected(path.join(home, 'Pictures', 'Vacation')).protected).toBe(true);
    expect(isPathProtected(path.join(home, 'Desktop')).protected).toBe(true);
  });

  it('允许合法的缓存目录通过黑名单校验，但必须位于已确认集合中', () => {
    const npmCache = path.join(os.homedir(), 'AppData', 'Local', 'npm-cache');
    expect(isPathProtected(npmCache).protected).toBe(false);

    const approved = new Set([path.resolve(npmCache).toLowerCase()]);
    expect(validateCleanTarget(npmCache, approved).valid).toBe(true);
    expect(validateCleanTarget('C:\\Unapproved\\Cache', approved).valid).toBe(false);
  });

  it('能够识别名字叫 Cache 但内含聊天原图或源码的伪缓存目录', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kanso-test-'));
    const fakeCache = path.join(tmpRoot, 'WeChat_Cache');
    fs.mkdirSync(fakeCache, { recursive: true });
    fs.writeFileSync(path.join(fakeCache, 'chat_photo_2026.jpg'), Buffer.alloc(1024));
    expect(hasUserMediaOrSourceFiles(fakeCache)).toBe(true);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: 安装依赖并运行测试验证失败**

Run: `npm install && npx vitest run tests/safety-guard.test.ts`
Expected: FAIL（`safety-guard.ts` 尚未实现）

- [ ] **Step 3: 实现 `src/core/safety/safety-guard.ts`**

实现完整的路径规范化、Windows 盘符根与系统目录黑名单、用户文稿/桌面/相册保护、符号链接防穿越检查以及伪缓存媒体/源码文件特征检测。

- [ ] **Step 4: 重新运行测试验证通过**

Run: `npx vitest run tests/safety-guard.test.ts`
Expected: PASS

- [ ] **Step 5: 提交代码**

```bash
git add package.json package-lock.json tsconfig.json src/shared/types.ts src/core/safety/safety-guard.ts tests/safety-guard.test.ts
git commit -m "功能：完成项目初始化、共享类型契约与安全沙盒守卫"
```

---

### Task 2: Windows 多盘符探测与固定规则扫描引擎 (`WindowsRulesScanner`)

**Files:**
- Create: `d:\cleardisk\src\core\scanner\windows-rules.ts`
- Test: `d:\cleardisk\tests\windows-scanner.test.ts`

**Interfaces:**
- Consumes: `DiskVolume`, `DiskStone`, `CleanRecommendation`, `ScanResult` from `src/shared/types.ts`, `isPathProtected`, `hasUserMediaOrSourceFiles` from `src/core/safety/safety-guard.ts`
- Produces:
  - `listWindowsVolumes(): Promise<DiskVolume[]>`
  - `getDirectorySizeFast(dirPath: string, maxDepth?: number, maxEntries?: number): number`
  - `runRulesScan(volumeId: string, customRootForTest?: string): Promise<ScanResult>`

- [ ] **Step 1: 编写针对多盘符探测与固定规则分类扫描的单元测试**

在 `tests/windows-scanner.test.ts` 中测试：
1. `listWindowsVolumes()` 能正确列出当前 Windows 系统的盘符（如 `C:`, `D:`）并返回非零的 `totalBytes` 和 `freeBytes`。
2. `runRulesScan()` 在模拟目录结构下能准确识别 `npm 缓存`、`pnpm store`、`个人内容（文稿与下载、照片图库）`、`本地 AI 模型`、`系统与启动` 以及 `未归类` 石块，并生成具有完整依据（`reason`）和确切命令（`command`）的清理建议。

- [ ] **Step 2: 运行测试验证失败**

Run: `npx vitest run tests/windows-scanner.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 `src/core/scanner/windows-rules.ts`**

实现：
1. 使用 `fs.statfsSync` 结合盘符枚举（`A:`-`Z:`）快速探测本机所有挂载驱动器及 `ALL` 全盘聚合容量，秒级响应且无需依赖缓慢的外部 WMI 进程。
2. 内置 30+ 项 Windows 常见路径规则（涵盖 `npm`, `pnpm`, `yarn`, `bun`, `pip`, `cargo`, `nuget`, `gradle`, `uv`, `VS Code Cache`, `Windows Temp`, `CrashDumps`, `第三方 AppData Cache`, `回收站`, `本地 AI 模型 Ollama/HuggingFace`, `Steam/Docker/WSL`, `微信/QQ/Telegram 聊天记录`, `文稿与下载`, `照片与视频`, `项目与代码`, `系统与启动`）。
3. 自动将所有分类占用汇总，剩余未命中已用空间归入 `未归类` 石块，并收集顶层未归类大文件夹供下一阶段 Agent 探索。

- [ ] **Step 4: 运行测试验证通过**

Run: `npx vitest run tests/windows-scanner.test.ts`
Expected: PASS

- [ ] **Step 5: 提交代码**

```bash
git add src/core/scanner/windows-rules.ts tests/windows-scanner.test.ts
git commit -m "功能：实现 Windows 多盘符容量探测与固定规则扫描引擎"
```

---

### Task 3: 混合探索 Agent、独立复核 Agent 与双模式安全清理器 (`HybridAgent` & `CleanerEngine`)

**Files:**
- Create: `d:\cleardisk\src\core\agent\hybrid-agent.ts`
- Create: `d:\cleardisk\src\core\cleaner\cleaner-engine.ts`
- Test: `d:\cleardisk\tests\hybrid-agent-cleaner.test.ts`

**Interfaces:**
- Consumes: `ScanResult`, `CleanRecommendation`, `AppSettings`, `CleanExecutionResult`, `WorkLogEntry` from `src/shared/types.ts`, `SafetyGuard` from `src/core/safety/safety-guard.ts`
- Produces:
  - `runAgentExplorationAndReview(scanResult: ScanResult, settings: AppSettings): Promise<{ updatedResult: ScanResult; logs: WorkLogEntry[] }>`
  - `executeClean(recommendations: CleanRecommendation[], selectedIds: string[], mode: 'direct' | 'agent', settings: AppSettings): Promise<CleanExecutionResult>`

- [ ] **Step 1: 编写双 Agent 探索复核（含伪缓存纠偏）与双模式安全清理的单元测试**

在 `tests/hybrid-agent-cleaner.test.ts` 中测试：
1. 探索 Agent 能发现未归类目录中的旧项目依赖（如 `old-project/node_modules`），同时将含有聊天原图（`.jpg`）的伪缓存目录从候选清理列表中剔除。
2. 独立复核 Agent (`ReviewerAgent`) 会撤回任何指向受保护路径或缺乏安全依据的建议。
3. `executeClean` 仅清理用户显式勾选（`selectedIds`）且通过安全校验的目录，支持直接清理与 Agent 清理（含进程检查与空间复测），并返回准确的实际释放字节数与工作记录日志。

- [ ] **Step 2: 运行测试验证失败**

Run: `npx vitest run tests/hybrid-agent-cleaner.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 `src/core/agent/hybrid-agent.ts` 与 `src/core/cleaner/cleaner-engine.ts`**

实现：
1. `hybrid-agent.ts`：支持调用本机 `claude` / `codex` CLI（只读 Prompt 约束）、自定义 OpenAI/Anthropic/Ollama API，以及高可靠内置启发式探索与独立复核器；对每条建议输出中文依据与撤回记录。
2. `cleaner-engine.ts`：实现 `direct`（直接清理）和 `agent`（让 Agent 清理：先核验路径未变、通过 `tasklist` 检查关联进程是否运行、逐项调用安全删除或移至 Windows 回收站、最后重新测量空间并生成工作记录）。

- [ ] **Step 4: 运行测试验证通过**

Run: `npx vitest run tests/hybrid-agent-cleaner.test.ts`
Expected: PASS

- [ ] **Step 5: 提交代码**

```bash
git add src/core/agent/hybrid-agent.ts src/core/cleaner/cleaner-engine.ts tests/hybrid-agent-cleaner.test.ts
git commit -m "功能：实现双 Agent 探索复核机制与双模式安全清理执行器"
```

---

### Task 4: 枯山水加权 Voronoi 石块与同心砂纹几何引擎 (`VoronoiGarden`)

**Files:**
- Create: `d:\cleardisk\src\renderer\voronoi-garden.ts`
- Test: `d:\cleardisk\tests\voronoi-garden.test.ts`

**Interfaces:**
- Consumes: `DiskStone`, `CleanRecommendation` from `src/shared/types.ts`
- Produces:
  - `GardenStoneRenderItem`: `{ id: string; label: string; sizeText: string; categoryClass: string; isHole: boolean; shapePath: string; ringsPath: string; labelX: number; labelY: number; isBigLabel: boolean; recommendationId?: string }`
  - `GardenLayoutResult`: `{ width: number; height: number; freeSpaceRingsPath: string; freeLabelX: number; freeLabelY: number; freeSizeText: string; stones: GardenStoneRenderItem[] }`
  - `computeKansoGardenLayout(params: { width: number; height: number; freeBytes: number; stones: DiskStone[]; selectedRecIds: Set<string>; isNarrow?: boolean }): GardenLayoutResult`

- [ ] **Step 1: 编写枯山水几何引擎与 SVG 路径生成单元测试**

在 `tests/voronoi-garden.test.ts` 中测试：
1. 给定宽屏（`1440x900`）与窄屏（`396x520`）尺寸、可用空间及各分类石块列表，生成的每个石块都具有包含二次贝塞尔曲线 `Q` 指令的闭合圆角 SVG `shapePath`。
2. 左上角控制面板留白区（如宽屏 `x < 520, y < 600`）不会被右侧石块侵入遮挡。
3. 可用空间区域必生成多层同心砂纹 `freeSpaceRingsPath`；当某个缓存石块对应的 `recommendationId` 被加入 `selectedRecIds` 时，该石块自动标记 `isHole: true` 并生成内部多层同心砂纹 `ringsPath`。

- [ ] **Step 2: 运行测试验证失败**

Run: `npx vitest run tests/voronoi-garden.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 `src/renderer/voronoi-garden.ts`**

实现：
1. 采用 Sutherland-Hodgman 半平面多边形裁剪实现加权 Voronoi (Power Diagram) 细分算法 + 质心面积自适应调整，使每块石头的视觉面积严格反映其磁盘占用大小，同时完美避开左上角控制面板留白区。
2. 实现多边形向内等距法线缩进（Inset Polygon）与二次贝塞尔圆角平滑（`M ... Q ... L ... Z`），与原版 Kanso SVG 路径语法 100% 一致。
3. 为“可用空间”及所有已勾选待清理的 `.stone.hole` 石块自动生成多层同心缩进砂纹路径（`.rings`）。

- [ ] **Step 4: 运行测试验证通过**

Run: `npx vitest run tests/voronoi-garden.test.ts`
Expected: PASS

- [ ] **Step 5: 提交代码**

```bash
git add src/renderer/voronoi-garden.ts tests/voronoi-garden.test.ts
git commit -m "功能：实现枯山水加权 Voronoi 圆角石块与同心砂纹几何引擎"
```

---

### Task 5: 桌面渲染 UI、Electron 主进程集成与全流程视觉验证

**Files:**
- Create: `d:\cleardisk\src\renderer\styles.css`
- Create: `d:\cleardisk\src\renderer\index.html`
- Create: `d:\cleardisk\src\renderer\app.ts`
- Create: `d:\cleardisk\src\main\preload.ts`
- Create: `d:\cleardisk\src\main\main.ts`
- Test: `d:\cleardisk\tests\design-tokens.test.ts`

**Interfaces:**
- Consumes: `WindowsRulesScanner`, `HybridAgent`, `CleanerEngine`, `VoronoiGarden`
- Produces: 完整可运行的 Electron 桌面应用及自动化截图验证支持

- [ ] **Step 1: 编写设计令牌 (`design-tokens.test.ts`) 单元测试**

参考原版 Kanso `site.css` 第一行注释（`core/test/design.test.ts checks it`），编写测试验证 `src/renderer/styles.css` 包含完整的浅色与深色模式色彩令牌（`--ground`, `--ink`, `--on-ink`, `--rake`, `--s-content`, `--s-tools`, `--s-caches`, `--s-system` 等）及 `.stone.hole`、`.rings` 样式规则。

- [ ] **Step 2: 运行测试验证失败**

Run: `npx vitest run tests/design-tokens.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 `src/renderer/` 与 `src/main/` 完整应用代码**

实现：
1. `src/renderer/styles.css`：1:1 复刻原版 Kanso 的设计令牌、无卡片无阴影极简排版、左上角建议清单复选框与全选、顶部盘符选择器、石块悬停提示、清理依据详情浮层、【工作记录】与【设置】抽屉、浅色/深色主题切换。
2. `src/renderer/index.html` & `src/renderer/app.ts`：
   - 展示实时计算的 `XXX G 清理所选后可用（现在 YYY G）` 与 `可以清理 AA.A G，其中 BB.B G 可以放心删除。`
   - 渲染 `● 可安全清理` 与 `◐ 确认后清理` 列表，点击复选框时右侧 SVG 石块实时切换 `.hole` 镂空同心砂纹状态。
   - 点击任意条目或石块可查看确切路径、判断依据与执行命令。
   - 支持切换盘符（`C:`, `D:`, `全部磁盘`）、点击 `重新扫描`、打开 `工作记录` 查看双 Agent 扫描复核日志、打开 `设置` 配置 Agent 后端（自动 / Claude Code / Codex / 自定义 API）与清理方式（移至回收站 / 直接永久清理）。
3. `src/main/preload.ts` & `src/main/main.ts`：
   - 注册 IPC 处理器（`kanso:list-volumes`, `kanso:scan`, `kanso:agent-review`, `kanso:clean`, `kanso:get-settings`, `kanso:save-settings`, `kanso:get-worklogs`）。
   - 支持命令行 `--capture-screenshots <dir>` 参数，在启动真实 Electron 窗口后自动截取浅色模式、深色模式及勾选清理项镂空砂纹状态的高清窗口截图，用于视觉回归验证。

- [ ] **Step 4: 编译 TypeScript，运行全量单元测试与真实 Electron 桌面截图验证**

Run:
```powershell
npm run build
npx vitest run
npx electron dist/main/main.js --capture-screenshots "C:/Users/navy/.gemini/antigravity/brain/7dfd1351-250d-4ea5-a5eb-be42e0293d86"
```
Expected: 所有测试 100% PASS，成功生成真实 Electron 窗口运行截图。

- [ ] **Step 5: 提交全部代码**

```bash
git add src/ tests/ package.json tsconfig.json
git commit -m "功能：完成 Kanso Windows 桌面端 UI、Electron 主进程集成与视觉验证"
```

