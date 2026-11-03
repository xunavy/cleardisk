# Kanso Windows 版 — 磁盘用量分析与混合 Agent 清理工具设计规范

> [!IMPORTANT]
> 本设计规范旨在将 macOS 上的 **Kanso** ([kanso.botiverse.build](https://kanso.botiverse.build/zh-hans/)) 完整复刻至 **Windows 平台**。在 1:1 还原日式枯山水（Voronoi 圆角石块 + 同心砂纹）视觉与交互体系的同时，深度适配 Windows 多盘符文件系统、常见开发/应用缓存生态、本地 CLI Agent (`claude` / `codex`) 与 LLM API 协同扫描复核机制，以及只读沙盒与回收站安全边界。

---

## 1. 系统整体架构

![Kanso Windows 版系统整体架构与混合扫描流程图](file:///C:/Users/navy/.gemini/antigravity/brain/7dfd1351-250d-4ea5-a5eb-be42e0293d86/kanso_windows_architecture.png)

### 1.1 技术栈与进程划分
系统采用 **Electron + TypeScript** 多进程/多线程架构，划分为以下四个核心单元：

1. **桌面渲染层 (`src/renderer/`)**：
   - 负责无卡片、无阴影、基于 CSS Tokens (`--ground`, `--ink`, `--rake`, `--s-content`, `--s-tools`, `--s-caches`, `--s-system`) 的日式枯山水界面渲染与用户交互。
   - 内置 **Voronoi 枯山水几何引擎 (`voronoi-garden.ts`)**：在保留左上角控制面板留白区的前提下，根据磁盘各部分实际占用面积生成圆角多边形石块（二次贝塞尔曲线 `Q` 指令）与同心缩进砂纹（`.rings`）。
2. **主进程协调器 (`src/main/`)**：
   - 管理 Electron 原生窗口、系统托盘/菜单、IPC 通信通道 (`ipc-handlers.ts`)、工作记录持久化 (`worklog-store.ts`) 与用户配置持久化 (`settings-store.ts`)。
3. **Windows 规则扫描与容量计算引擎 (`src/core/scanner/`)**：
   - 探测 Windows 逻辑驱动器（`C:`, `D:` 等及全盘聚合视图）的总容量、可用空间与已用空间。
   - 快速扫描 30+ 项 Windows 常见用户目录、开发工具缓存、包管理器缓存、本地 AI 模型、系统休眠/更新缓存及未归类大文件夹。
4. **双 Agent 探索/复核与安全清理引擎 (`src/core/agent/` & `src/core/cleaner/`)**：
   - **探索 Agent (`scanner-agent.ts`)**：支持调用本机 `claude` (Claude Code CLI)、`codex` (Codex CLI) 或 OpenAI / Anthropic / Ollama 兼容 API，在只读约束下分析未归类目录并纠偏伪缓存。
   - **复核 Agent (`reviewer-agent.ts`)**：独立上下文审查每条候选清理建议，撤回任何无法确认安全的建议。
   - **安全守卫与清理器 (`safety-guard.ts` & `cleaner-engine.ts`)**：执行硬编码受保护目录黑名单拦截、关联进程运行态检测、移至 Windows 回收站或彻底删除，并在清理后复测空间写入工作记录。

---

## 2. 枯山水视觉与交互规范

### 2.1 色彩令牌与深浅色主题
严格遵循原版 Kanso `site.css` 的设计令牌（颜色越深代表越难找回）：

| 语义令牌 | 浅色模式 (`light`) | 深色模式 (`dark`) | 对应 Windows 磁盘数据分类 |
| :--- | :--- | :--- | :--- |
| `--ground` / `--ink` | `#efebe1` / `#2a2926` | `#1a1916` / `#e8e3d7` | 庭院砂地背景色 / 墨色文字与边框 |
| `--rake` | `#cfc9ba` | `#3a3832` | 可用空间与已勾选镂空石块的同心砂纹线条 |
| `个人内容 (--s-content)` | 石 `#2a2926` / 字 `#f4f1e9` | 石 `#e8e3d7` / 字 `#1a1916` | 文稿与下载、桌面、图片与视频、聊天记录 (微信/QQ/Telegram)、项目与代码 |
| `开发与工具 (--s-tools)` | 石 `#75726a` / 字 `#ffffff` | 石 `#96938a` / 字 `#14130f` | 本地 AI 模型 (Ollama/HF)、Visual Studio & SDK、WSL & Docker、Steam 与游戏、其他应用 |
| `缓存与构建 (--s-caches)` | 石 `#d3cec0` / 字 `#2a2926` | 石 `#3f3d37` / 字 `#e8e3d7` | npm / pnpm / yarn / bun / pip / cargo / nuget / gradle 缓存、构建产物、应用缓存、回收站 |
| `系统与启动 (--s-system)` | 石 `#e3ded2` / 字 `#55524a` | 石 `#282723` / 字 `#bdb9ad` | Windows 系统目录、系统资源与数据 (休眠文件/虚拟内存/WinSxS/系统临时文件) |
| `未归类 (--f-unknown)` | 透明底 + 虚线墨色描边 | 透明底 + 虚线浅色描边 | 规则未命中的大体积目录（交由 Agent 探索归类） |

### 2.2 布局与核心交互细节
1. **顶部导航栏**：左侧展示应用标志 `Kanso` 与 **Windows 盘符切换器**（支持单盘符如 `C:`、`D:` 或 `全部磁盘`）；右侧提供 `重新扫描`、`工作记录`、`设置` 与主题切换按钮。
2. **左上角建议面板（留白区）**：
   - **大字可用空间看板**：动态计算并展示 `XXX G 清理所选后可用（现在 YYY G）`，勾选或取消勾选任意清理项时实时跳动更新。
   - **汇总提示语**：`可以清理 AA.A G，其中 BB.B G 可以放心删除。`
   - **分组清单**：
     - `● 可安全清理`：右侧显示 `已选 X.X G / Y.Y G 全选`，列出纯缓存、包管理器存储、构建产物等 100% 可再生条目。
     - `◐ 确认后清理`：右侧显示 `Z.Z G 全选`，列出第三方应用缓存、清空 Windows 回收站、浏览器缓存等需用户知晓副作用的条目。
   - **清理依据详情**：点击任意建议项或石块，可展开查看该项的**清理依据、确切路径、占用大小以及将要执行的命令**。
   - **底部双按钮**：`让 Agent 清理 N 项`（主实心按钮）与 `直接清理`（次描边按钮）。默认绝不替用户预勾选任何一项（或者仅在演示/用户点击全选时勾选，严格遵守“不替你勾选任何一项，你不确认就不会删除”原则）。
3. **右侧与底部枯山水石块图**：
   - `可用` 区域始终位于左上控制面板右侧黄金视觉位，绘制多层同心砂纹（`.rings`）。
   - 当用户在左侧勾选某条清理建议时，右侧对应的缓存石块实时添加 `.hole` 类：石块底色褪去变为透明粗描边，且内部浮现多层同心砂纹（`.rings`），直观反馈“清理后此处将化为可用砂地”。

---

## 3. 混合扫描、双 Agent 复核与清理时序流

![Kanso Windows 版混合扫描、双 Agent 复核与双模式清理时序图](file:///C:/Users/navy/.gemini/antigravity/brain/7dfd1351-250d-4ea5-a5eb-be42e0293d86/kanso_windows_workflow.png)

### 3.1 阶段一：Windows 固定规则扫描清单
规则扫描器内置针对 Windows 生态的高效并发探测规则：

- **可安全清理 (`safe`)**：
  1. `npm 缓存` (`%LOCALAPPDATA%\npm-cache` 或 `%APPDATA%\npm-cache`)
  2. `pnpm store` (`%LOCALAPPDATA%\pnpm\store` 或盘符根下 `.pnpm-store`)
  3. `Yarn 缓存` (`%LOCALAPPDATA%\Yarn\Cache`)
  4. `Bun 缓存` (`%USERPROFILE%\.bun\install\cache`)
  5. `pip 缓存` (`%LOCALAPPDATA%\pip\Cache`)
  6. `Cargo 缓存` (`%USERPROFILE%\.cargo\registry\cache` & `git\db`)
  7. `NuGet 包缓存` (`%USERPROFILE%\.nuget\packages` / `%LOCALAPPDATA%\NuGet\v3-cache`)
  8. `Gradle / Maven 缓存` (`%USERPROFILE%\.gradle\caches`)
  9. `Windows 用户临时文件` (`%TEMP%`)
  10. `崩溃转储与错误报告` (`%LOCALAPPDATA%\CrashDumps` & `Microsoft\Windows\WER`)
  11. `Visual Studio / VS Code 缓存` (`%APPDATA%\Code\Cache`, `CachedData`, `GPUCache`)
- **确认后清理 (`confirm`)**：
  1. `清空第三方应用缓存`（扫描 `%LOCALAPPDATA%` 与 `%APPDATA%` 下各应用的 `Cache`/`Code Cache`/`GPUCache` 目录，排除聊天软件原图目录）
  2. `清空回收站`（统计各盘符 `$Recycle.Bin` 当前用户回收站大小）
  3. `旧项目构建产物`（扫描工作区/代码目录下超过 14 天未修改项目的 `node_modules`、`target`、`dist`、`.next`、`build` 目录）
  4. `Windows 更新与下载缓存` (`C:\Windows\SoftwareDistribution\Download`)
- **不可清理的占用石块分类 (`content` / `tools` / `system` / `unknown`)**：
  - `个人内容`：文稿与下载 (`Documents` + `Downloads` + `Desktop`)、照片与视频 (`Pictures` + `Videos` + `Music`)、聊天记录 (`WeChat Files` / `Tencent Files` / `Telegram Desktop`)、项目与代码（源码仓库主体）。
  - `开发与工具`：本地 AI 模型 (`%USERPROFILE%\.ollama\models`, `%USERPROFILE%\.cache\huggingface`, `%USERPROFILE%\.lmstudio`)、WSL 与 Docker 虚拟磁盘 (`ext4.vhdx`)、Visual Studio 与 SDK (`Program Files\Microsoft Visual Studio`, `Windows Kits`, `Android\Sdk`)、Steam 与游戏 (`Steam\steamapps`)、其他应用 (`Program Files`, `Program Files (x86)`, `%LOCALAPPDATA%\Programs`)。
  - `系统与启动`：`C:\Windows`、休眠与虚拟内存文件 (`hiberfil.sys`, `pagefile.sys`)、系统资源与数据 (`ProgramData`)。
  - `未归类`：已用空间减去上述已识别分类后的剩余空间，及盘符根目录下未命中的大文件夹。

### 3.2 阶段二 & 阶段三：双 Agent 探索与独立复核
1. **探索 Agent (`ScannerAgent`)**：
   - **只读沙盒执行**：向 Agent 仅提供只读目录结构摘要（文件夹路径、大小、最后修改时间、顶层子文件名样本，绝不授予写/删工具权限）。
   - **支持三类后端（可在【设置】中切换）**：
     - 本地 CLI Agent：自动调用本机已安装的 `claude -p` 或 `codex exec`（只读分析模式）。
     - 自定义 LLM API：支持配置 OpenAI / Anthropic / DeepSeek / 本地 Ollama (`http://localhost:11434/v1`) 接口。
     - 智能离线规则回退：当用户未联网或未开启外部 Agent 时，使用内置启发式深度分析器完成未归类目录剖析与伪缓存纠偏。
   - **伪缓存纠偏**：若发现某个目录虽包含 `Cache` 或 `Temp` 字样，但内部包含 `.jpg`/`.png`/`.mp4`/`.docx`/`.git` 等用户原创或聊天原图特征（例如微信 `FileStorage\Cache` 或项目源码目录），强制标记为 `unsafe` 并从建议清单中剔除。
2. **复核 Agent (`ReviewerAgent`)**：
   - 接收候选清理建议列表，在独立规则与 Prompt 下逐条验证：
     - 路径是否落在受保护黑名单之外？
     - 删除依据是否成立？删除后是否仅影响缓存或可自动重建？
   - 任何存疑项直接撤回，并在【工作记录】中记录撤回原因。

### 3.3 安全边界 (`SafetyGuard`) 与双模式清理 (`CleanerEngine`)
1. **受保护路径硬编码黑名单**：
   - 严禁删除盘符根目录（如 `C:\`, `D:\`）、`C:\Windows\System32`、`C:\Windows\SysWOW64`、`C:\Program Files`、用户 `Desktop`、`Documents`、`Pictures`、`Videos`、以及微信/QQ聊天记录主体目录。
   - 删除前强制规范化路径 (`path.resolve`)，校验路径必须精确匹配已通过复核的候选条目路径，且拒绝跟随指向黑名单区域的符号链接 (`ReparsePoint`)。
2. **直接清理 vs 让 Agent 清理**：
   - **直接清理**：立即对用户勾选的条目执行清理（默认使用 PowerShell / Shell API 移入 Windows 回收站，或按用户设置永久清理目录内容），清理后刷新磁盘用量。
   - **让 Agent 清理**：
     1. **路径与时间戳复验**：确认目标目录自扫描完成以来未被篡改。
     2. **关联进程运行态检查**：通过 `tasklist` 检查目标缓存所属应用（如 `Code.exe`, `devenv.exe`, `chrome.exe`, `node.exe`, `cargo.exe`）是否正在运行；若正在运行且锁死文件，自动跳过或提示关闭，绝不暴力破坏运行态应用。
     3. **逐项执行与空间复测**：逐项清理后重新测量磁盘实际可用空间，生成详细的释放报告（实际释放多少 GB、哪些跳过未动）并存入【工作记录】。

---

## 4. 错误处理与测试策略

### 4.1 错误处理
- **权限不足 (`EPERM` / `EACCES`)**：Windows 系统目录（如 `System Volume Information`、`WinSxS`）在非管理员权限下读取受限时，扫描器自动捕获并静默跳过，使用磁盘总已用空间差值兜底计算，绝不崩溃或中断扫描。
- **文件被占用 (`EBUSY`)**：清理过程中若部分正在使用的临时文件被系统锁死，按文件粒度容错清理其余未锁定文件，并在结果报告中如实展示“实际已释放空间”与“因进程占用跳过的剩余大小”。
- **Agent 超时或额度耗尽**：CLI Agent 或 API 调用设置超时保护，若失败则平滑回退并保留固定规则扫描结果，界面给出清晰状态提示。

### 4.2 自动化测试设计
- **单元测试 (`vitest`)**：
  1. **设计令牌与枯山水几何测试 (`design-voronoi.test.ts`)**：验证 CSS Tokens 完整性、Voronoi 多边形面积权重分配、二次贝塞尔圆角路径生成以及 `.rings` 同心砂纹缩进路径合法性。
  2. **Windows 规则与伪缓存纠偏测试 (`scanner-agent.test.ts`)**：验证常见缓存规则识别、聊天原图伪缓存（如名为 `Cache` 但含聊天图片）被探索/复核 Agent 拦截剔除。
  3. **安全沙盒黑名单测试 (`safety-guard.test.ts`)**：验证针对 `Documents`、`Pictures`、`C:\Windows\System32` 及未确认路径的删除请求 100% 被拒绝。
- **端到端桌面运行验证**：启动 Electron 应用，验证浅色/深色主题、盘符切换、石块勾选镂空砂纹动画、建议详情查看、工作记录与设置面板完整可用。

