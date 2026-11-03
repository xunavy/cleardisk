import { contextBridge, ipcRenderer } from 'electron';
import {
  AppSettings,
  CleanExecutionResult,
  CleanMode,
  CleanRecommendation,
  DiskStone,
  DiskVolume,
  ScanResult,
  WorkLogEntry
} from '../shared/types';
import { computeKansoGardenLayout, GardenLayoutResult } from '../renderer/voronoi-garden';

export interface KansoRendererBridge {
  listVolumes(): Promise<DiskVolume[]>;
  scanVolume(volumeId: string): Promise<ScanResult>;
  runAgentReview(scanResult: ScanResult): Promise<{ updatedResult: ScanResult; logs: WorkLogEntry[] }>;
  executeClean(
    recommendations: CleanRecommendation[],
    selectedIds: string[],
    mode: CleanMode
  ): Promise<CleanExecutionResult>;
  getSettings(): Promise<AppSettings>;
  saveSettings(settings: Partial<AppSettings>): Promise<AppSettings>;
  getWorkLogs(): Promise<WorkLogEntry[]>;
  openPathInExplorer(targetPath: string): Promise<boolean>;
  computeGardenLayout(params: {
    width: number;
    height: number;
    freeBytes: number;
    stones: DiskStone[];
    selectedRecIds: string[];
    panelRightPx?: number;
    panelBottomPx?: number;
  }): GardenLayoutResult;
}

const api: KansoRendererBridge = {
  listVolumes: () => ipcRenderer.invoke('kanso:list-volumes'),
  scanVolume: (volumeId: string) => ipcRenderer.invoke('kanso:scan-volume', volumeId),
  runAgentReview: (scanResult: ScanResult) => ipcRenderer.invoke('kanso:agent-review', scanResult),
  executeClean: (
    recommendations: CleanRecommendation[],
    selectedIds: string[],
    mode: CleanMode
  ) => ipcRenderer.invoke('kanso:execute-clean', { recommendations, selectedIds, mode }),
  getSettings: () => ipcRenderer.invoke('kanso:get-settings'),
  saveSettings: (settings: Partial<AppSettings>) => ipcRenderer.invoke('kanso:save-settings', settings),
  getWorkLogs: () => ipcRenderer.invoke('kanso:get-worklogs'),
  openPathInExplorer: (targetPath: string) => ipcRenderer.invoke('kanso:open-path', targetPath),
  computeGardenLayout: (params) =>
    computeKansoGardenLayout({
      width: params.width,
      height: params.height,
      freeBytes: params.freeBytes,
      stones: params.stones,
      selectedRecIds: new Set(params.selectedRecIds),
      panelRightPx: params.panelRightPx,
      panelBottomPx: params.panelBottomPx
    })
};

contextBridge.exposeInMainWorld('kansoApi', api);
