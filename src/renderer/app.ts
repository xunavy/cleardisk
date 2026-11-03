/**
 * Kanso Windows 版 — 桌面渲染层前端交互控制器
 * 负责驱动左上角控制面板、枯山水 SVG 石块与同心砂纹、盘符切换、双模式清理及模态框
 */

interface KansoWindowBridge {
  listVolumes(): Promise<any[]>;
  scanVolume(volumeId: string): Promise<any>;
  runAgentReview(scanResult: any): Promise<{ updatedResult: any; logs: any[] }>;
  executeClean(recommendations: any[], selectedIds: string[], mode: 'direct' | 'agent'): Promise<any>;
  getSettings(): Promise<any>;
  saveSettings(settings: any): Promise<any>;
  getWorkLogs(): Promise<any[]>;
  computeGardenLayout(params: {
    width: number;
    height: number;
    freeBytes: number;
    stones: any[];
    selectedRecIds: string[];
    panelRightPx?: number;
    panelBottomPx?: number;
  }): any;
}

interface Window {
  kansoApi: KansoWindowBridge;
  __kansoTestHelper?: {
    selectTopSafeItems(count: number): void;
    setTheme(theme: 'light' | 'dark'): void;
    openWorklogModal(): void;
    closeModals(): void;
    isScanReady(): boolean;
  };
}

(function initKansoApp() {
  let currentVolumeId = 'ALL';
  let currentScanResult: any = null;
  let selectedRecIds = new Set<string>();
  let expandedRecIds = new Set<string>();
  let currentSettings: any = null;
  let scanCompleted = false;

  // DOM 引用
  const volumeSelector = document.getElementById('volume-selector') as HTMLSelectElement;
  const heroFreeAfter = document.getElementById('hero-free-after') as HTMLElement;
  const heroFreeNow = document.getElementById('hero-free-now') as HTMLElement;
  const heroSummaryLead = document.getElementById('hero-summary-lead') as HTMLElement;

  const safeSelectedSummary = document.getElementById('safe-selected-summary') as HTMLElement;
  const confirmSelectedSummary = document.getElementById('confirm-selected-summary') as HTMLElement;
  const safeRecList = document.getElementById('safe-rec-list') as HTMLUListElement;
  const confirmRecList = document.getElementById('confirm-rec-list') as HTMLUListElement;

  const btnSelectAllSafe = document.getElementById('btn-select-all-safe') as HTMLButtonElement;
  const btnSelectAllConfirm = document.getElementById('btn-select-all-confirm') as HTMLButtonElement;
  const btnCleanAgent = document.getElementById('btn-clean-agent') as HTMLButtonElement;
  const btnCleanDirect = document.getElementById('btn-clean-direct') as HTMLButtonElement;
  const agentStatusBar = document.getElementById('agent-status-bar') as HTMLElement;

  const freeRingsPath = document.getElementById('free-rings-path') as unknown as SVGPathElement;
  const freeLabelTitle = document.getElementById('free-label-title') as unknown as SVGTextElement;
  const freeLabelSize = document.getElementById('free-label-size') as unknown as SVGTextElement;
  const stonesContainer = document.getElementById('stones-container') as unknown as SVGGElement;

  const btnRescan = document.getElementById('btn-rescan') as HTMLButtonElement;
  const btnWorklog = document.getElementById('btn-worklog') as HTMLButtonElement;
  const btnSettings = document.getElementById('btn-settings') as HTMLButtonElement;

  const modalWorklog = document.getElementById('modal-worklog') as HTMLElement;
  const btnCloseWorklog = document.getElementById('btn-close-worklog') as HTMLButtonElement;
  const worklogList = document.getElementById('worklog-list') as HTMLElement;

  const modalSettings = document.getElementById('modal-settings') as HTMLElement;
  const btnCloseSettings = document.getElementById('btn-close-settings') as HTMLButtonElement;
  const btnSaveSettings = document.getElementById('btn-save-settings') as HTMLButtonElement;
  const settingTheme = document.getElementById('setting-theme') as HTMLSelectElement;
  const settingAgentBackend = document.getElementById('setting-agent-backend') as HTMLSelectElement;
  const settingDeleteMethod = document.getElementById('setting-delete-method') as HTMLSelectElement;
  const settingApiEndpoint = document.getElementById('setting-api-endpoint') as HTMLInputElement;
  const settingApiKey = document.getElementById('setting-api-key') as HTMLInputElement;

  function formatGBNumber(bytes: number, decimals = 1): string {
    const gb = Math.max(0, bytes) / 1024 ** 3;
    if (decimals === 0 || gb >= 100) {
      return `${Math.round(gb)}`;
    }
    return gb.toFixed(decimals);
  }

  function applyTheme(theme: 'system' | 'light' | 'dark'): void {
    if (theme === 'light' || theme === 'dark') {
      document.documentElement.setAttribute('data-theme', theme);
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
  }

  /**
   * 渲染左上角统计看板与建议清单
   */
  function renderControlPanel(): void {
    if (!currentScanResult) return;

    const recs: any[] = currentScanResult.recommendations || [];
    const safeRecs = recs.filter((r) => r.riskLevel === 'safe');
    const confirmRecs = recs.filter((r) => r.riskLevel === 'confirm');

    const totalSafeBytes = safeRecs.reduce((s, r) => s + r.sizeBytes, 0);
    const totalConfirmBytes = confirmRecs.reduce((s, r) => s + r.sizeBytes, 0);
    const totalCleanableBytes = totalSafeBytes + totalConfirmBytes;

    const selectedSafeBytes = safeRecs
      .filter((r) => selectedRecIds.has(r.id))
      .reduce((s, r) => s + r.sizeBytes, 0);
    const selectedConfirmBytes = confirmRecs
      .filter((r) => selectedRecIds.has(r.id))
      .reduce((s, r) => s + r.sizeBytes, 0);
    const totalSelectedBytes = selectedSafeBytes + selectedConfirmBytes;

    const freeNowBytes = currentScanResult.volume.freeBytes;
    const freeAfterBytes = freeNowBytes + totalSelectedBytes;

    heroFreeAfter.textContent = formatGBNumber(freeAfterBytes, 0);
    heroFreeNow.textContent = `清理所选后可用（现在 ${formatGBNumber(freeNowBytes, 0)} G）`;
    heroSummaryLead.textContent = `可以清理 ${formatGBNumber(totalCleanableBytes, 1)} G，其中 ${formatGBNumber(
      totalSafeBytes,
      1
    )} G 可以放心删除。`;

    safeSelectedSummary.textContent = `已选 ${formatGBNumber(selectedSafeBytes, 1)} G / ${formatGBNumber(
      totalSafeBytes,
      1
    )} G`;
    confirmSelectedSummary.textContent =
      selectedConfirmBytes > 0
        ? `已选 ${formatGBNumber(selectedConfirmBytes, 1)} G / ${formatGBNumber(totalConfirmBytes, 1)} G`
        : `${formatGBNumber(totalConfirmBytes, 1)} G`;

    const allSafeSelected = safeRecs.length > 0 && safeRecs.every((r) => selectedRecIds.has(r.id));
    btnSelectAllSafe.textContent = allSafeSelected ? '取消全选' : '全选';

    const allConfirmSelected =
      confirmRecs.length > 0 && confirmRecs.every((r) => selectedRecIds.has(r.id));
    btnSelectAllConfirm.textContent = allConfirmSelected ? '取消全选' : '全选';

    renderRecList(safeRecList, safeRecs);
    renderRecList(confirmRecList, confirmRecs);

    const selectedCount = selectedRecIds.size;
    btnCleanAgent.textContent =
      selectedCount > 0 ? `让 Agent 清理 ${selectedCount} 项` : '让 Agent 清理';
    btnCleanAgent.disabled = selectedCount === 0;
    btnCleanDirect.disabled = selectedCount === 0;
  }

  function renderRecList(container: HTMLUListElement, items: any[]): void {
    container.innerHTML = '';

    if (items.length === 0) {
      const emptyLi = document.createElement('li');
      emptyLi.className = 'rec-item';
      emptyLi.innerHTML = `<div class="rec-row"><span class="rec-title" style="opacity:0.65;">当前无此类别待清理项</span></div>`;
      container.appendChild(emptyLi);
      return;
    }

    for (const item of items) {
      const li = document.createElement('li');
      li.className = 'rec-item';

      const row = document.createElement('div');
      row.className = 'rec-row';

      const left = document.createElement('div');
      left.className = 'rec-left';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'kanso-check';
      checkbox.checked = selectedRecIds.has(item.id);
      checkbox.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleRecommendationSelection(item.id);
      });

      const titleSpan = document.createElement('span');
      titleSpan.className = 'rec-title';
      titleSpan.textContent = item.title;
      titleSpan.title = `${item.title}（点击查看清理依据与确切命令）`;

      left.appendChild(checkbox);
      left.appendChild(titleSpan);

      const sizeSpan = document.createElement('span');
      sizeSpan.className = 'rec-size';
      sizeSpan.textContent = item.sizeText;

      row.appendChild(left);
      row.appendChild(sizeSpan);

      row.addEventListener('click', () => {
        if (expandedRecIds.has(item.id)) {
          expandedRecIds.delete(item.id);
        } else {
          expandedRecIds.add(item.id);
        }
        renderControlPanel();
      });

      li.appendChild(row);

      if (expandedRecIds.has(item.id)) {
        const detailDiv = document.createElement('div');
        detailDiv.className = 'rec-detail';
        detailDiv.innerHTML = `
          <p><strong>依据：</strong>${escapeHtml(item.reason)}</p>
          <p><strong>复核状态：</strong>${escapeHtml(item.reviewNote || '已通过独立 Agent 安全复核')}</p>
          <code class="rec-cmd">${escapeHtml(item.command)}</code>
        `;
        li.appendChild(detailDiv);
      }

      container.appendChild(li);
    }
  }

  /**
   * 渲染枯山水 Voronoi 庭院石块与同心砂纹
   */
  function renderGardenMap(): void {
    if (!currentScanResult) return;

    const svgEl = document.getElementById('garden-svg') as unknown as SVGSVGElement;
    const cornerEl = document.querySelector('.control-corner') as HTMLElement;
    const vw = Math.max(960, window.innerWidth || 1440);
    const vh = Math.max(640, window.innerHeight || 900);
    svgEl.setAttribute('viewBox', `0 0 ${vw} ${vh}`);

    const cornerRect = cornerEl ? cornerEl.getBoundingClientRect() : { right: vw * 0.34, bottom: vh * 0.68 };

    const layout = window.kansoApi.computeGardenLayout({
      width: vw,
      height: vh,
      freeBytes: currentScanResult.volume.freeBytes,
      stones: currentScanResult.stones,
      selectedRecIds: Array.from(selectedRecIds),
      panelRightPx: cornerRect.right + 16,
      panelBottomPx: cornerRect.bottom + 14
    });

    freeRingsPath.setAttribute('d', layout.freeSpaceRingsPath);
    freeLabelTitle.setAttribute('x', String(layout.freeLabelX));
    freeLabelTitle.setAttribute('y', String(layout.freeLabelY - 8));
    freeLabelSize.setAttribute('x', String(layout.freeLabelX));
    freeLabelSize.setAttribute('y', String(layout.freeLabelY + 13));
    freeLabelSize.textContent = layout.freeSizeText;

    stonesContainer.innerHTML = '';
    const svgNs = 'http://www.w3.org/2000/svg';

    for (const st of layout.stones) {
      const g = document.createElementNS(svgNs, 'g');
      const classes = ['stone', st.categoryClass];
      if (st.isHole) classes.push('hole');
      g.setAttribute('class', classes.join(' '));

      const shape = document.createElementNS(svgNs, 'path');
      shape.setAttribute('class', 'shape');
      shape.setAttribute('d', st.shapePath);
      g.appendChild(shape);

      if (st.isHole && st.ringsPath) {
        const rings = document.createElementNS(svgNs, 'path');
        rings.setAttribute('class', 'rings');
        rings.setAttribute('d', st.ringsPath);
        g.appendChild(rings);
      }

      if (st.showLabel) {
        const textGroup = document.createElementNS(svgNs, 'g');
        const nameText = document.createElementNS(svgNs, 'text');
        if (st.isBigLabel) nameText.setAttribute('class', 'big');
        nameText.setAttribute('x', String(st.labelX));
        nameText.setAttribute('y', String(st.labelY - 6));

        const maxLen = st.isBigLabel ? 14 : 7;
        const displayLabel =
          st.label.length > maxLen ? `${st.label.slice(0, maxLen - 1)}...` : st.label;
        nameText.textContent = displayLabel;

        const sizeText = document.createElementNS(svgNs, 'text');
        sizeText.setAttribute('class', st.isBigLabel ? 'size big' : 'size');
        sizeText.setAttribute('x', String(st.labelX));
        sizeText.setAttribute('y', String(st.labelY + 14));
        sizeText.textContent = st.sizeText;

        textGroup.appendChild(nameText);
        textGroup.appendChild(sizeText);
        g.appendChild(textGroup);
      }

      const titleEl = document.createElementNS(svgNs, 'title');
      titleEl.textContent = `${st.label} (${st.sizeText})${
        st.recommendationId ? ' — 点击石块可切换清理勾选状态' : ''
      }`;
      g.appendChild(titleEl);

      g.addEventListener('click', () => {
        if (st.recommendationId) {
          toggleRecommendationSelection(st.recommendationId);
        } else {
          agentStatusBar.textContent = `${st.label} (${st.sizeText})：属于个人内容或系统工具，Kanso 默认保护不予清理。`;
        }
      });

      stonesContainer.appendChild(g);
    }
  }

  function toggleRecommendationSelection(recId: string): void {
    if (selectedRecIds.has(recId)) {
      selectedRecIds.delete(recId);
    } else {
      selectedRecIds.add(recId);
    }
    renderControlPanel();
    renderGardenMap();
  }

  function escapeHtml(str: string): string {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  async function startFullScan(volumeId: string): Promise<void> {
    scanCompleted = false;
    selectedRecIds.clear();
    expandedRecIds.clear();
    agentStatusBar.textContent = '阶段 1/3：正在使用固定规则快速扫描常见位置...';

    // 第一阶段：固定规则秒级扫描
    const ruleScan = await window.kansoApi.scanVolume(volumeId);
    currentScanResult = ruleScan;
    renderControlPanel();
    renderGardenMap();

    agentStatusBar.textContent = '阶段 2/3：编程 Agent 正在排查未归类目录并由独立 Agent 复核安全性...';

    // 第二 & 第三阶段：探索 Agent 排查 + 独立复核 Agent 检验
    const { updatedResult } = await window.kansoApi.runAgentReview(ruleScan);
    currentScanResult = updatedResult;
    agentStatusBar.textContent = updatedResult.agentStatusText;
    renderControlPanel();
    renderGardenMap();
    scanCompleted = true;
  }

  async function handleClean(mode: 'direct' | 'agent'): Promise<void> {
    if (!currentScanResult || selectedRecIds.size === 0) return;

    btnCleanAgent.disabled = true;
    btnCleanDirect.disabled = true;
    agentStatusBar.textContent =
      mode === 'agent'
        ? 'Agent 正在确认目标路径一致性、检测宿主应用进程状态并逐项执行清理...'
        : 'Kanso 正在直接执行您勾选确认的清理项...';

    const cleanRes = await window.kansoApi.executeClean(
      currentScanResult.recommendations,
      Array.from(selectedRecIds),
      mode
    );

    agentStatusBar.textContent = cleanRes.summaryText;
    await startFullScan(currentVolumeId);
    agentStatusBar.textContent = cleanRes.summaryText;
  }

  // 事件绑定
  btnSelectAllSafe.addEventListener('click', () => {
    if (!currentScanResult) return;
    const safeRecs: any[] = currentScanResult.recommendations.filter(
      (r: any) => r.riskLevel === 'safe'
    );
    const allSelected = safeRecs.length > 0 && safeRecs.every((r) => selectedRecIds.has(r.id));
    for (const r of safeRecs) {
      if (allSelected) selectedRecIds.delete(r.id);
      else selectedRecIds.add(r.id);
    }
    renderControlPanel();
    renderGardenMap();
  });

  btnSelectAllConfirm.addEventListener('click', () => {
    if (!currentScanResult) return;
    const confirmRecs: any[] = currentScanResult.recommendations.filter(
      (r: any) => r.riskLevel === 'confirm'
    );
    const allSelected =
      confirmRecs.length > 0 && confirmRecs.every((r) => selectedRecIds.has(r.id));
    for (const r of confirmRecs) {
      if (allSelected) selectedRecIds.delete(r.id);
      else selectedRecIds.add(r.id);
    }
    renderControlPanel();
    renderGardenMap();
  });

  btnCleanAgent.addEventListener('click', () => handleClean('agent'));
  btnCleanDirect.addEventListener('click', () => handleClean('direct'));
  btnRescan.addEventListener('click', () => startFullScan(currentVolumeId));

  volumeSelector.addEventListener('change', () => {
    currentVolumeId = volumeSelector.value;
    startFullScan(currentVolumeId);
  });

  btnWorklog.addEventListener('click', async () => {
    const logs = await window.kansoApi.getWorkLogs();
    worklogList.innerHTML = '';
    if (!logs || logs.length === 0) {
      worklogList.innerHTML = '<p style="opacity:0.7;">暂无工作记录</p>';
    } else {
      for (const log of logs) {
        const div = document.createElement('div');
        div.className = 'log-item';
        const timeStr = new Date(log.timestamp).toLocaleString('zh-CN');
        div.innerHTML = `
          <div class="log-item-head">
            <span>${escapeHtml(log.title)}</span>
            <span class="log-item-time">${escapeHtml(timeStr)}</span>
          </div>
          <div class="log-item-detail">${escapeHtml(log.detail)}</div>
        `;
        worklogList.appendChild(div);
      }
    }
    modalWorklog.hidden = false;
  });

  btnCloseWorklog.addEventListener('click', () => {
    modalWorklog.hidden = true;
  });

  btnSettings.addEventListener('click', async () => {
    currentSettings = await window.kansoApi.getSettings();
    settingTheme.value = currentSettings.theme || 'light';
    settingAgentBackend.value = currentSettings.agentBackend || 'auto';
    settingDeleteMethod.value = currentSettings.deleteMethod || 'recycle';
    settingApiEndpoint.value = currentSettings.llmApiEndpoint || '';
    settingApiKey.value = currentSettings.llmApiKey || '';
    modalSettings.hidden = false;
  });

  btnCloseSettings.addEventListener('click', () => {
    modalSettings.hidden = true;
  });

  btnSaveSettings.addEventListener('click', async () => {
    currentSettings = await window.kansoApi.saveSettings({
      theme: settingTheme.value,
      agentBackend: settingAgentBackend.value,
      deleteMethod: settingDeleteMethod.value,
      llmApiEndpoint: settingApiEndpoint.value.trim(),
      llmApiKey: settingApiKey.value.trim()
    });
    applyTheme(currentSettings.theme);
    modalSettings.hidden = true;
    agentStatusBar.textContent = '设置已保存并立即生效。';
  });

  window.addEventListener('resize', () => {
    if (currentScanResult) {
      renderGardenMap();
    }
  });

  // 暴露测试与截图辅助钩子
  window.__kansoTestHelper = {
    selectTopSafeItems(count: number) {
      if (!currentScanResult) return;
      selectedRecIds.clear();
      const safeRecs = currentScanResult.recommendations.filter((r: any) => r.riskLevel === 'safe');
      for (const r of safeRecs.slice(0, count)) {
        selectedRecIds.add(r.id);
      }
      renderControlPanel();
      renderGardenMap();
    },
    setTheme(theme: 'light' | 'dark') {
      applyTheme(theme);
    },
    openWorklogModal() {
      btnWorklog.click();
    },
    closeModals() {
      modalWorklog.hidden = true;
      modalSettings.hidden = true;
    },
    isScanReady() {
      return scanCompleted;
    }
  };

  // 启动初始化流程
  (async function bootstrap() {
    currentSettings = await window.kansoApi.getSettings();
    applyTheme(currentSettings.theme);

    const volumes = await window.kansoApi.listVolumes();
    volumeSelector.innerHTML = '';
    for (const vol of volumes) {
      const opt = document.createElement('option');
      opt.value = vol.id;
      opt.textContent = vol.label;
      volumeSelector.appendChild(opt);
    }
    currentVolumeId = 'ALL';
    volumeSelector.value = 'ALL';

    await startFullScan(currentVolumeId);
  })();
})();
