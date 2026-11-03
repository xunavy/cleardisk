import { DiskStone, StoneCategory } from '../shared/types';
import { formatBytesToKansoSize } from '../core/safety/safety-guard';

export interface Point2D {
  x: number;
  y: number;
}

export interface GardenStoneRenderItem {
  id: string;
  label: string;
  sizeText: string;
  category: StoneCategory;
  /** 对应原版 CSS 类：f-content | f-tools | f-caches | f-system | f-unknown */
  categoryClass: string;
  /** 当该石块关联的清理建议被用户勾选时，变为 true（渲染 .stone.hole 镂空砂纹） */
  isHole: boolean;
  /** 二次贝塞尔圆角外轮廓 SVG Path */
  shapePath: string;
  /** 若 isHole 为 true，生成的多层同心砂纹 SVG Path */
  ringsPath: string;
  /** 文字中心坐标 X */
  labelX: number;
  /** 文字中心坐标 Y */
  labelY: number;
  /** 是否使用大号字体 (.big) */
  isBigLabel: boolean;
  /** 是否空间足够显示文字标签 */
  showLabel: boolean;
  /** 关联的清理建议 ID */
  recommendationId?: string;
  /** 关联的真实路径列表 */
  paths: string[];
}

export interface GardenLayoutResult {
  width: number;
  height: number;
  /** 可用空间同心砂纹 SVG Path */
  freeSpaceRingsPath: string;
  freeLabelX: number;
  freeLabelY: number;
  freeSizeText: string;
  stones: GardenStoneRenderItem[];
}

/**
 * 计算多边形有向面积与质心（正面积表示顺时针/屏幕坐标系下顺时针）
 */
export function polygonAreaAndCentroid(pts: Point2D[]): {
  area: number;
  signedArea: number;
  cx: number;
  cy: number;
} {
  const n = pts.length;
  if (n < 3) return { area: 0, signedArea: 0, cx: 0, cy: 0 };

  let a = 0;
  let cx = 0;
  let cy = 0;

  for (let i = 0; i < n; i++) {
    const p0 = pts[i];
    const p1 = pts[(i + 1) % n];
    const cross = p0.x * p1.y - p1.x * p0.y;
    a += cross;
    cx += (p0.x + p1.x) * cross;
    cy += (p0.y + p1.y) * cross;
  }

  const signedArea = a * 0.5;
  const area = Math.abs(signedArea);
  if (area < 1e-5) {
    const avgX = pts.reduce((s, p) => s + p.x, 0) / n;
    const avgY = pts.reduce((s, p) => s + p.y, 0) / n;
    return { area: 0, signedArea: 0, cx: avgX, cy: avgY };
  }

  return {
    area,
    signedArea,
    cx: cx / (3 * a),
    cy: cy / (3 * a)
  };
}

/**
 * 确保凸多边形顶点按顺时针 (signedArea > 0) 排列
 */
function ensureClockwise(pts: Point2D[]): Point2D[] {
  if (pts.length < 3) return pts;
  const { signedArea } = polygonAreaAndCentroid(pts);
  return signedArea < 0 ? [...pts].reverse() : pts;
}

/**
 * Sutherland-Hodgman 半平面裁剪：保留满足 nx * x + ny * y <= c 的区域
 */
export function clipPolygonHalfPlane(
  poly: Point2D[],
  nx: number,
  ny: number,
  c: number
): Point2D[] {
  if (poly.length === 0) return [];
  const out: Point2D[] = [];
  const n = poly.length;

  for (let i = 0; i < n; i++) {
    const cur = poly[i];
    const prev = poly[(i + n - 1) % n];
    const curVal = nx * cur.x + ny * cur.y - c;
    const prevVal = nx * prev.x + ny * prev.y - c;
    const curIn = curVal <= 1e-6;
    const prevIn = prevVal <= 1e-6;

    if (curIn !== prevIn) {
      const denom = prevVal - curVal;
      const t = Math.abs(denom) > 1e-9 ? prevVal / denom : 0.5;
      out.push({
        x: prev.x + t * (cur.x - prev.x),
        y: prev.y + t * (cur.y - prev.y)
      });
    }
    if (curIn) {
      out.push(cur);
    }
  }

  // 合并过近的相邻顶点，防止数值退化
  const cleaned: Point2D[] = [];
  for (const p of out) {
    const last = cleaned[cleaned.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 0.8) {
      cleaned.push(p);
    }
  }
  if (
    cleaned.length > 1 &&
    Math.hypot(
      cleaned[0].x - cleaned[cleaned.length - 1].x,
      cleaned[0].y - cleaned[cleaned.length - 1].y
    ) <= 0.8
  ) {
    cleaned.pop();
  }

  return cleaned;
}

/**
 * 将凸多边形每条边沿内法线方向等距缩进 insetDist 像素
 */
export function insetConvexPolygon(pts: Point2D[], insetDist: number): Point2D[] {
  if (pts.length < 3 || insetDist <= 0) return pts;
  const cw = ensureClockwise(pts);
  let result = [...cw];
  const n = cw.length;

  for (let i = 0; i < n; i++) {
    const p0 = cw[i];
    const p1 = cw[(i + 1) % n];
    const dx = p1.x - p0.x;
    const dy = p1.y - p0.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-5) continue;

    // 在屏幕坐标系 (x向右, y向下) 下，顺时针多边形的外法线为 (dy / len, -dx / len)
    const nx = dy / len;
    const ny = -dx / len;
    const c = nx * p0.x + ny * p0.y - insetDist;

    result = clipPolygonHalfPlane(result, nx, ny, c);
    if (result.length < 3) return [];
  }

  return result;
}

/**
 * 将凸多边形转换为原版 Kanso 风格的二次贝塞尔圆角 SVG Path (M ... Q ... L ... Z)
 */
export function polygonToRoundedSvgPath(pts: Point2D[], cornerRadius = 24): string {
  if (pts.length < 3) return '';
  const n = pts.length;
  const commands: string[] = [];

  for (let i = 0; i < n; i++) {
    const prev = pts[(i + n - 1) % n];
    const curr = pts[i];
    const next = pts[(i + 1) % n];

    const vPrevX = prev.x - curr.x;
    const vPrevY = prev.y - curr.y;
    const lenPrev = Math.hypot(vPrevX, vPrevY);

    const vNextX = next.x - curr.x;
    const vNextY = next.y - curr.y;
    const lenNext = Math.hypot(vNextX, vNextY);

    if (lenPrev < 1e-3 || lenNext < 1e-3) continue;

    const r = Math.min(cornerRadius, lenPrev * 0.44, lenNext * 0.44);
    const sx = curr.x + (vPrevX / lenPrev) * r;
    const sy = curr.y + (vPrevY / lenPrev) * r;
    const ex = curr.x + (vNextX / lenNext) * r;
    const ey = curr.y + (vNextY / lenNext) * r;

    const f = (v: number) => Number(v.toFixed(1));

    if (commands.length === 0) {
      commands.push(`M${f(sx)} ${f(sy)}`);
    } else {
      commands.push(`L${f(sx)} ${f(sy)}`);
    }
    commands.push(`Q${f(curr.x)} ${f(curr.y)} ${f(ex)} ${f(ey)}`);
  }

  if (commands.length === 0) return '';
  return `${commands.join('')}Z`;
}

/**
 * 为“可用空间”或已勾选的“.stone.hole”石块生成多层向内同心砂纹 (.rings)
 */
export function generateConcentricRingsPath(
  basePoly: Point2D[],
  ringSpacing = 11,
  maxRings = 16,
  initialCornerRadius = 26,
  startFromZero = false
): string {
  if (basePoly.length < 3) return '';
  const ringPaths: string[] = [];

  const startIdx = startFromZero ? 0 : 1;
  for (let k = startIdx; k <= maxRings; k++) {
    const inset = k * ringSpacing;
    const ringPoly = inset === 0 ? basePoly : insetConvexPolygon(basePoly, inset);
    if (ringPoly.length < 3) break;

    const { area } = polygonAreaAndCentroid(ringPoly);
    if (area < 280) break;

    // 检查包围盒短边，避免过扁闭合环
    let minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity;
    for (const p of ringPoly) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    if (Math.min(maxX - minX, maxY - minY) < 15) break;

    const r = Math.max(5, initialCornerRadius - k * 1.3);
    const d = polygonToRoundedSvgPath(ringPoly, r);
    if (d) ringPaths.push(d);
  }

  return ringPaths.join('');
}

interface VoronoiSite {
  id: string;
  x: number;
  y: number;
  weight: number;
  targetRatio: number;
  isFreeSpace?: boolean;
  stone?: DiskStone;
}

/**
 * 在给定的凸区域 domainPoly 内，对一组加权站点求 Power Diagram 细胞并做面积松弛
 */
function computeWeightedVoronoiCells(
  domainPoly: Point2D[],
  sites: VoronoiSite[],
  iterations = 8
): Map<string, Point2D[]> {
  const cwDomain = ensureClockwise(domainPoly);
  const { area: domainArea } = polygonAreaAndCentroid(cwDomain);
  const resultCells = new Map<string, Point2D[]>();

  if (sites.length === 0) return resultCells;
  if (sites.length === 1) {
    resultCells.set(sites[0].id, cwDomain);
    return resultCells;
  }

  for (let iter = 0; iter < iterations; iter++) {
    resultCells.clear();

    for (let i = 0; i < sites.length; i++) {
      const si = sites[i];
      let cell = [...cwDomain];

      for (let j = 0; j < sites.length; j++) {
        if (i === j) continue;
        const sj = sites[j];
        const dx = sj.x - si.x;
        const dy = sj.y - si.y;
        const distSq = dx * dx + dy * dy;
        if (distSq < 1e-4) continue;

        const dist = Math.sqrt(distSq);
        const nx = dx / dist;
        const ny = dy / dist;

        // Power Diagram 平分线偏移量受 weight 差值调制（限制幅度防止吞并相邻站点）
        const maxShift = dist * 0.32;
        const weightDiff = Math.max(-maxShift, Math.min(maxShift, (si.weight - sj.weight) / dist));
        const midX = (si.x + sj.x) * 0.5 + nx * weightDiff;
        const midY = (si.y + sj.y) * 0.5 + ny * weightDiff;
        const c = nx * midX + ny * midY;

        cell = clipPolygonHalfPlane(cell, nx, ny, c);
        if (cell.length < 3) break;
      }

      resultCells.set(si.id, cell);
    }

    // 除最后一轮外，向各自细胞质心温和松弛并按目标面积调整权重
    if (iter < iterations - 1) {
      for (const s of sites) {
        const cell = resultCells.get(s.id);
        if (!cell || cell.length < 3) continue;
        const { area, cx, cy } = polygonAreaAndCentroid(cell);

        // 固定可用空间站点在左上黄金位附近，其余站点向质心平滑靠近
        const moveFactor = s.isFreeSpace ? 0.12 : 0.35;
        s.x = s.x + (cx - s.x) * moveFactor;
        s.y = s.y + (cy - s.y) * moveFactor;

        const currentRatio = area / Math.max(1, domainArea);
        const ratioErr = s.targetRatio - currentRatio;
        s.weight += ratioErr * domainArea * 0.08;
      }
    }
  }

  return resultCells;
}

function getCategoryClass(category: StoneCategory): string {
  switch (category) {
    case 'content':
      return 'f-content';
    case 'tools':
      return 'f-tools';
    case 'caches':
      return 'f-caches';
    case 'system':
      return 'f-system';
    case 'unknown':
    default:
      return 'f-unknown';
  }
}

/**
 * 计算 Kanso 枯山水庭院完整布局
 * - 严格保留左上角控制面板留白区（x: 0..485, y: 0..635）
 * - 将可用空间放置于控制面板右侧黄金区并生成多层同心砂纹 (.rings)
 * - 将个人内容、开发工具、缓存、系统与未归类石块分布在底部与右侧主庭院区
 */
export function computeKansoGardenLayout(params: {
  width: number;
  height: number;
  freeBytes: number;
  stones: DiskStone[];
  selectedRecIds: Set<string>;
  isNarrow?: boolean;
}): GardenLayoutResult {
  const { width, height, freeBytes, stones, selectedRecIds } = params;
  const margin = 19;
  const stoneGap = 7.5;

  // 左上角控制面板边界（宽屏下留出左上 x: 0..485, y: 0..635 给建议列表与清理按钮）
  const panelRight = Math.round(width * 0.335); // 1440 下约为 482
  const panelBottom = Math.round(height * 0.705); // 900 下约为 634

  // 底部左侧凸区域（放置 2~3 块高权重个人内容大石块，如“文稿与下载”、“聊天记录”）
  const bottomLeftDomain: Point2D[] = [
    { x: margin, y: panelBottom + 8 },
    { x: panelRight - 8, y: panelBottom + 2 },
    { x: panelRight - 14, y: height - margin },
    { x: margin, y: height - margin }
  ];

  // 右侧与中下部主庭院凸区域（涵盖可用空间砂纹区 + 主石块群）
  const mainGardenDomain: Point2D[] = [
    { x: panelRight + 6, y: margin },
    { x: width - margin, y: margin },
    { x: width - margin, y: height - margin },
    { x: panelRight + 2, y: height - margin }
  ];

  // 挑选最多 2 块非可清理的 content 石块放入底部左侧区域，其余放入主庭院区域
  const contentStones = stones.filter((s) => s.category === 'content' && !s.recommendationId);
  const bottomLeftStones = contentStones.slice(1, 3);
  const bottomLeftIds = new Set(bottomLeftStones.map((s) => s.id));
  const mainGardenStones = stones.filter((s) => !bottomLeftIds.has(s.id));

  const renderedStones: GardenStoneRenderItem[] = [];

  // 1. 计算底部左侧区域 Voronoi 细胞
  if (bottomLeftStones.length > 0) {
    const totalBL = bottomLeftStones.reduce((s, st) => s + Math.max(st.sizeBytes, 1), 0);
    const blSites: VoronoiSite[] = bottomLeftStones.map((st, idx) => {
      const ratio = Math.max(st.sizeBytes, 1) / totalBL;
      const xSpan = panelRight - margin - 20;
      const xPos =
        bottomLeftStones.length === 1
          ? margin + xSpan * 0.5
          : margin + xSpan * (idx === 0 ? 0.28 : 0.74);
      const yPos = panelBottom + (height - panelBottom) * (idx === 0 ? 0.52 : 0.48);
      return {
        id: st.id,
        x: xPos,
        y: yPos,
        weight: ratio * 4000,
        targetRatio: ratio,
        stone: st
      };
    });

    const blCells = computeWeightedVoronoiCells(bottomLeftDomain, blSites, 6);
    for (const site of blSites) {
      const rawCell = blCells.get(site.id);
      if (!rawCell || rawCell.length < 3 || !site.stone) continue;
      const insetCell = insetConvexPolygon(rawCell, stoneGap);
      if (insetCell.length < 3) continue;

      const { area, cx, cy } = polygonAreaAndCentroid(insetCell);
      const shapePath = polygonToRoundedSvgPath(insetCell, 24);
      if (!shapePath) continue;

      const isHole = Boolean(
        site.stone.recommendationId && selectedRecIds.has(site.stone.recommendationId)
      );
      const ringsPath = isHole
        ? generateConcentricRingsPath(insetCell, 10.5, 10, 20, false)
        : '';

      renderedStones.push({
        id: site.stone.id,
        label: site.stone.label,
        sizeText: site.stone.sizeText,
        category: site.stone.category,
        categoryClass: getCategoryClass(site.stone.category),
        isHole,
        shapePath,
        ringsPath,
        labelX: Number(cx.toFixed(1)),
        labelY: Number(cy.toFixed(1)),
        isBigLabel: area > 22000,
        showLabel: area > 4500,
        recommendationId: site.stone.recommendationId,
        paths: site.stone.paths
      });
    }
  }

  // 2. 计算主庭院区域（含“可用空间”砂纹细胞 + 主石块群）
  // 预设有机庭院锚点，使不同类别石块按 Kanso 美学自然分区排布：
  // - 可用空间：左上靠控制面板右侧 (x: 0.22, y: 0.24)
  // - caches（可清理项）：右上角区域 (x: 0.78..0.95, y: 0.08..0.42)，勾选时镂空砂纹一目了然
  // - tools（AI模型/开发工具/应用）：中上与右中 (x: 0.52..0.88, y: 0.14..0.62)
  // - content（照片图库/代码）：中下主视觉位 (x: 0.18..0.52, y: 0.64..0.92)
  // - system / unknown：右下角 (x: 0.65..0.92, y: 0.72..0.92)
  const mgLeft = panelRight + 6;
  const mgWidth = width - margin - mgLeft;
  const mgTop = margin;
  const mgHeight = height - margin * 2;

  const effectiveFreeBytes = Math.max(freeBytes, 25 * 1024 ** 3);
  const totalMainBytes =
    effectiveFreeBytes +
    mainGardenStones.reduce((acc, s) => acc + Math.max(s.sizeBytes, 8 * 1024 ** 3), 0);

  const mgSites: VoronoiSite[] = [];

  // 加入可用空间站点
  const freeRatio = Math.max(0.16, Math.min(0.38, effectiveFreeBytes / Math.max(1, totalMainBytes)));
  mgSites.push({
    id: '__free_space__',
    x: mgLeft + mgWidth * 0.21,
    y: mgTop + mgHeight * 0.23,
    weight: freeRatio * 18000,
    targetRatio: freeRatio,
    isFreeSpace: true
  });

  // 按类别分配自然锚点坐标
  const cachesAnchors = [
    [0.82, 0.10],
    [0.94, 0.10],
    [0.83, 0.26],
    [0.95, 0.28],
    [0.74, 0.34],
    [0.92, 0.42]
  ];
  const toolsAnchors = [
    [0.57, 0.15],
    [0.48, 0.39],
    [0.84, 0.56],
    [0.56, 0.60],
    [0.68, 0.22]
  ];
  const contentAnchors = [
    [0.24, 0.68],
    [0.14, 0.90],
    [0.42, 0.86]
  ];
  const sysUnknownAnchors = [
    [0.64, 0.86],
    [0.90, 0.86],
    [0.92, 0.70]
  ];

  let cIdx = 0,
    tIdx = 0,
    cntIdx = 0,
    sIdx = 0;

  for (const st of mainGardenStones) {
    const effBytes = Math.max(st.sizeBytes, 8 * 1024 ** 3);
    const ratio = effBytes / Math.max(1, totalMainBytes);
    let anchor: number[];

    if (st.category === 'caches') {
      anchor = cachesAnchors[cIdx % cachesAnchors.length];
      cIdx++;
    } else if (st.category === 'tools') {
      anchor = toolsAnchors[tIdx % toolsAnchors.length];
      tIdx++;
    } else if (st.category === 'content') {
      anchor = contentAnchors[cntIdx % contentAnchors.length];
      cntIdx++;
    } else {
      anchor = sysUnknownAnchors[sIdx % sysUnknownAnchors.length];
      sIdx++;
    }

    // 防止多个同类别石块锚点完全重合
    const jitterX = ((cIdx + tIdx + cntIdx + sIdx) % 3 - 1) * 14;
    const jitterY = ((cIdx * 2 + tIdx) % 3 - 1) * 12;

    mgSites.push({
      id: st.id,
      x: mgLeft + mgWidth * anchor[0] + jitterX,
      y: mgTop + mgHeight * anchor[1] + jitterY,
      weight: ratio * 16000,
      targetRatio: ratio,
      stone: st
    });
  }

  const mgCells = computeWeightedVoronoiCells(mainGardenDomain, mgSites, 8);

  // 生成可用空间同心砂纹
  const freeRawCell = mgCells.get('__free_space__') || [
    { x: mgLeft, y: mgTop },
    { x: mgLeft + 340, y: mgTop },
    { x: mgLeft + 280, y: mgTop + 340 },
    { x: mgLeft, y: mgTop + 380 }
  ];
  const freeInsetCell = insetConvexPolygon(freeRawCell, stoneGap);
  const freeCentroid = polygonAreaAndCentroid(freeInsetCell);
  const freeSpaceRingsPath = generateConcentricRingsPath(freeInsetCell, 11.5, 16, 28, true);

  // 生成主庭院各石块
  for (const site of mgSites) {
    if (site.isFreeSpace || !site.stone) continue;
    const rawCell = mgCells.get(site.id);
    if (!rawCell || rawCell.length < 3) continue;

    const insetCell = insetConvexPolygon(rawCell, stoneGap);
    if (insetCell.length < 3) continue;

    const { area, cx, cy } = polygonAreaAndCentroid(insetCell);
    const shapePath = polygonToRoundedSvgPath(insetCell, 22);
    if (!shapePath) continue;

    const isHole = Boolean(
      site.stone.recommendationId && selectedRecIds.has(site.stone.recommendationId)
    );
    const ringsPath = isHole
      ? generateConcentricRingsPath(insetCell, 10.5, 12, 20, false)
      : '';

    renderedStones.push({
      id: site.stone.id,
      label: site.stone.label,
      sizeText: site.stone.sizeText,
      category: site.stone.category,
      categoryClass: getCategoryClass(site.stone.category),
      isHole,
      shapePath,
      ringsPath,
      labelX: Number(cx.toFixed(1)),
      labelY: Number(cy.toFixed(1)),
      isBigLabel: area > 24000,
      showLabel: area > 3800,
      recommendationId: site.stone.recommendationId,
      paths: site.stone.paths
    });
  }

  return {
    width,
    height,
    freeSpaceRingsPath,
    freeLabelX: Number(freeCentroid.cx.toFixed(1)),
    freeLabelY: Number(freeCentroid.cy.toFixed(1)),
    freeSizeText: formatBytesToKansoSize(freeBytes),
    stones: renderedStones
  };
}
