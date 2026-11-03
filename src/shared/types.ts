/**
 * Kanso Windows 版 — 跨主进程与渲染进程共享的数据类型契约
 * 遵循 Kanso 原版设计理念：石头颜色越深代表越难找回，有砂纹的区域代表可用空间或待清理释放空间
 */

/** 石块语义分类（对应 CSS 类 f-content, f-tools, f-caches, f-system, f-unknown） */
export type StoneCategory = 'content' | 'tools' | 'caches' | 'system' | 'unknown';

/** 清理建议风险分级：safe = 可安全清理，confirm = 确认后清理 */
export type CleanRiskLevel = 'safe' | 'confirm';

/** 清理执行模式：direct = 直接清理，agent = 让 Agent 清理（含进程检查与空间复测） */
export type CleanMode = 'direct' | 'agent';

/** 清理删除方式：recycle = 移至 Windows 回收站，permanent = 直接永久清理 */
export type CleanDeleteMethod = 'recycle' | 'permanent';

/** 编程 Agent 接入通道类型 */
export type AgentBackendType = 'auto' | 'claude-cli' | 'codex-cli' | 'llm-api' | 'heuristic';

/** Windows 磁盘卷信息 */
export interface DiskVolume {
  /** 盘符标识，如 "C:", "D:" 或 "ALL"（全部磁盘汇总） */
  id: string;
  /** 显示名称，如 "C: 系统盘", "D: 数据盘", "全部磁盘" */
  label: string;
  /** 根路径，如 "C:\\" */
  mountPath: string;
  /** 总容量（字节） */
  totalBytes: number;
  /** 可用空间（字节） */
  freeBytes: number;
  /** 已用空间（字节） */
  usedBytes: number;
}

/** 枯山水地图上的单个石块数据 */
export interface DiskStone {
  /** 唯一标识 */
  id: string;
  /** 石块显示名称，如 "照片图库"、"项目与代码"、"本地 AI 模型"、"npm 缓存" */
  label: string;
  /** 石块分类（决定颜色深浅：content 最深，tools 次之，caches 浅色，system 极浅，unknown 虚线） */
  category: StoneCategory;
  /** 占用字节数 */
  sizeBytes: number;
  /** 格式化后的大小文本，如 "188 G"、"14.5 G" */
  sizeText: string;
  /** 关联的真实磁盘路径列表 */
  paths: string[];
  /** 若该石块可清理，关联的清理建议 ID（勾选后该石块变为 .stone.hole 镂空同心砂纹） */
  recommendationId?: string;
  /** 简短说明 */
  description?: string;
}

/** 清理建议条目 */
export interface CleanRecommendation {
  /** 唯一标识 */
  id: string;
  /** 建议标题，如 "npm 缓存"、"pnpm store"、"清空回收站" */
  title: string;
  /** 风险级别：safe（可安全清理）或 confirm（确认后清理） */
  riskLevel: CleanRiskLevel;
  /** 预计可释放字节数 */
  sizeBytes: number;
  /** 格式化后的大小文本，如 "6.8 G" */
  sizeText: string;
  /** 关联的目标路径列表 */
  paths: string[];
  /** 判断依据说明（向用户解释为什么能删、删了有什么影响） */
  reason: string;
  /** 确切的执行命令展示文本 */
  command: string;
  /** 来源：rule（固定规则）、agent（探索 Agent 发现） */
  source: 'rule' | 'agent';
  /** 是否已通过独立复核 Agent 检验 */
  reviewed: boolean;
  /** 复核备注 */
  reviewNote?: string;
  /** 关联的宿主进程名列表（用于“让 Agent 清理”时检测应用是否在运行） */
  relatedProcesses?: string[];
  /** 扫描时的目录最后修改时间戳（用于清理前校验路径未发生意外变动） */
  scannedMtimeMs?: number;
}

/** 未归类大目录摘要（供探索 Agent 在只读沙盒中分析） */
export interface UnclassifiedDirSample {
  path: string;
  name: string;
  sizeBytes: number;
  lastModifiedMs: number;
  /** 顶层子文件名样本（只读摘要，不含文件内容） */
  sampleChildren: string[];
}

/** 完整扫描结果 */
export interface ScanResult {
  /** 当前扫描的盘符卷信息 */
  volume: DiskVolume;
  /** 扫描完成时间戳 */
  scannedAt: number;
  /** 扫描耗时（毫秒） */
  durationMs: number;
  /** 枯山水石块列表 */
  stones: DiskStone[];
  /** 清理建议列表（仅包含已通过安全校验与复核的建议） */
  recommendations: CleanRecommendation[];
  /** 待探索的未归类目录样本 */
  unclassifiedSamples: UnclassifiedDirSample[];
  /** 扫描阶段状态说明 */
  agentStatusText: string;
  /** Agent 复核撤回的危险或存疑条目计数 */
  withdrawnCount: number;
}

/** 工作记录日志条目 */
export interface WorkLogEntry {
  id: string;
  timestamp: number;
  type: 'scan' | 'agent-explore' | 'agent-review' | 'clean-direct' | 'clean-agent' | 'safety-block';
  title: string;
  detail: string;
  /** 涉及路径 */
  paths?: string[];
  /** 释放字节数（清理操作时记录） */
  freedBytes?: number;
}

/** 清理执行返回结果 */
export interface CleanExecutionResult {
  success: boolean;
  mode: CleanMode;
  /** 实际清理成功的建议 ID 列表 */
  cleanedIds: string[];
  /** 因进程运行、路径变化或安全拦截而跳过的条目 */
  skippedItems: Array<{ id: string; title: string; reason: string }>;
  /** 清理前可用空间（字节） */
  freeBytesBefore: number;
  /** 清理后重新测量的可用空间（字节） */
  freeBytesAfter: number;
  /** 实际释放的总字节数 */
  actualFreedBytes: number;
  /** 格式化后的释放空间文本 */
  actualFreedText: string;
  /** 汇总报告文案 */
  summaryText: string;
  /** 本次清理产生的工作记录 */
  logs: WorkLogEntry[];
}

/** 应用设置项 */
export interface AppSettings {
  /** 主题模式：system（跟随系统）、light（浅色枯山水）、dark（深色枯山水） */
  theme: 'system' | 'light' | 'dark';
  /** 编程 Agent 接入通道 */
  agentBackend: AgentBackendType;
  /** 自定义 LLM API 地址（如 https://api.openai.com/v1 或 http://localhost:11434/v1） */
  llmApiEndpoint: string;
  /** 自定义 LLM API 密钥 */
  llmApiKey: string;
  /** 自定义 LLM 模型名称 */
  llmModel: string;
  /** 清理删除方式：默认移至 Windows 回收站 */
  deleteMethod: CleanDeleteMethod;
  /** 自定义扫描排除目录列表 */
  excludedPaths: string[];
}

