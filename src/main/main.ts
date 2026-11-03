import { app, BrowserWindow, ipcMain, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import {
  AppSettings,
  CleanMode,
  CleanRecommendation,
  ScanResult,
  WorkLogEntry
} from '../shared/types';
import { listWindowsVolumes, runRulesScan } from '../core/scanner/windows-rules';
import { runAgentExplorationAndReview } from '../core/agent/hybrid-agent';
import { executeClean } from '../core/cleaner/cleaner-engine';

let mainWindow: BrowserWindow | null = null;
const workLogs: WorkLogEntry[] = [];

const defaultSettings: AppSettings = {
  theme: 'light',
  agentBackend: 'auto',
  llmApiEndpoint: '',
  llmApiKey: '',
  llmModel: 'gpt-4o-mini',
  deleteMethod: 'recycle',
  excludedPaths: []
};

let currentSettings: AppSettings = { ...defaultSettings };

function getSettingsFilePath(): string {
  return path.join(app.getPath('userData'), 'kanso-settings.json');
}

function loadPersistedSettings(): void {
  try {
    const p = getSettingsFilePath();
    if (fs.existsSync(p)) {
      const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
      currentSettings = { ...defaultSettings, ...raw };
    }
  } catch {
    currentSettings = { ...defaultSettings };
  }
}

function savePersistedSettings(partial: Partial<AppSettings>): AppSettings {
  currentSettings = { ...currentSettings, ...partial };
  try {
    fs.writeFileSync(getSettingsFilePath(), JSON.stringify(currentSettings, null, 2), 'utf-8');
  } catch {
    // ignore write error
  }
  return currentSettings;
}

function registerIpcHandlers(): void {
  ipcMain.handle('kanso:list-volumes', async () => {
    return listWindowsVolumes();
  });

  ipcMain.handle('kanso:scan-volume', async (_event, volumeId: string) => {
    const result = await runRulesScan(volumeId || 'ALL');
    workLogs.unshift({
      id: `log-scan-${Date.now()}`,
      timestamp: Date.now(),
      type: 'scan',
      title: `完成磁盘固定规则扫描 (${result.volume.label})`,
      detail: `扫描耗时 ${result.durationMs} ms，发现 ${result.recommendations.length} 项固定规则可清理项，可用空间 ${
        Math.round(result.volume.freeBytes / 1024 ** 3)
      } G。`
    });
    return result;
  });

  ipcMain.handle('kanso:agent-review', async (_event, scanResult: ScanResult) => {
    const res = await runAgentExplorationAndReview(scanResult, currentSettings);
    for (const log of res.logs.reverse()) {
      workLogs.unshift(log);
    }
    return res;
  });

  ipcMain.handle(
    'kanso:execute-clean',
    async (
      _event,
      payload: {
        recommendations: CleanRecommendation[];
        selectedIds: string[];
        mode: CleanMode;
      }
    ) => {
      const res = await executeClean(
        payload.recommendations,
        payload.selectedIds,
        payload.mode,
        currentSettings
      );
      for (const log of res.logs.reverse()) {
        workLogs.unshift(log);
      }
      return res;
    }
  );

  ipcMain.handle('kanso:get-settings', async () => {
    return currentSettings;
  });

  ipcMain.handle('kanso:save-settings', async (_event, partial: Partial<AppSettings>) => {
    return savePersistedSettings(partial);
  });

  ipcMain.handle('kanso:get-worklogs', async () => {
    return workLogs.slice(0, 100);
  });

  ipcMain.handle('kanso:open-path', async (_event, targetPath: string) => {
    if (targetPath && fs.existsSync(targetPath)) {
      shell.showItemInFolder(path.resolve(targetPath));
      return true;
    }
    return false;
  });
}

async function runAutomatedScreenshotCapture(
  win: BrowserWindow,
  outputDir: string
): Promise<void> {
  // 等待前端完成规则扫描与双 Agent 复核
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 300));
    const ready = await win.webContents.executeJavaScript(
      'Boolean(window.__kansoTestHelper && window.__kansoTestHelper.isScanReady())'
    );
    if (ready) break;
  }

  // 勾选前 2 项安全清理建议，使右上角对应缓存石块呈现 .stone.hole 镂空同心砂纹效果
  await win.webContents.executeJavaScript(`
    window.__kansoTestHelper.setTheme('light');
    window.__kansoTestHelper.selectTopSafeItems(2);
  `);
  await new Promise((r) => setTimeout(r, 450));

  const lightImg = await win.webContents.capturePage();
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, 'kanso_windows_app_light.png'), lightImg.toPNG());

  // 切换至深色枯山水模式截图
  await win.webContents.executeJavaScript(`
    window.__kansoTestHelper.setTheme('dark');
  `);
  await new Promise((r) => setTimeout(r, 450));

  const darkImg = await win.webContents.capturePage();
  fs.writeFileSync(path.join(outputDir, 'kanso_windows_app_dark.png'), darkImg.toPNG());

  // 打开工作记录审计面板截图
  await win.webContents.executeJavaScript(`
    window.__kansoTestHelper.setTheme('light');
    window.__kansoTestHelper.openWorklogModal();
  `);
  await new Promise((r) => setTimeout(r, 450));

  const worklogImg = await win.webContents.capturePage();
  fs.writeFileSync(path.join(outputDir, 'kanso_windows_app_worklog.png'), worklogImg.toPNG());

  app.quit();
}

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    title: 'Kanso — Windows 磁盘用量分析与清理工具',
    backgroundColor: '#efebe1',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  const indexPath = path.join(__dirname, '../renderer/index.html');
  mainWindow.loadFile(indexPath);

  const captureIdx = process.argv.indexOf('--capture-screenshots');
  if (captureIdx !== -1 && process.argv[captureIdx + 1]) {
    const outDir = process.argv[captureIdx + 1];
    mainWindow.webContents.once('did-finish-load', () => {
      if (mainWindow) {
        runAutomatedScreenshotCapture(mainWindow, outDir).catch((err) => {
          console.error('Screenshot error:', err);
          app.quit();
        });
      }
    });
  }
}

app.whenReady().then(() => {
  loadPersistedSettings();
  registerIpcHandlers();
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
