// 问题识别：在栅格上做连通域聚类，把覆盖差异变成一条条带证据的"问题条目"
import {
  convexHull,
} from './geo.js';
import { FINDING_TYPES } from './constants.js';

const NEIGHBORS4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/** 在候选栅格集合上做 4 邻域连通域标注，返回 [{indices:Set, areaM2}] */
export function labelComponents(grid, candidates) {
  const seen = new Set();
  const components = [];
  for (const start of candidates) {
    if (seen.has(start)) continue;
    const stack = [start];
    const indices = new Set();
    seen.add(start);
    while (stack.length) {
      const idx = stack.pop();
      indices.add(idx);
      const [ix, iy] = grid.coordOf(idx);
      for (const [dx, dy] of NEIGHBORS4) {
        const nx = ix + dx, ny = iy + dy;
        if (!grid.inBounds(nx, ny)) continue;
        const nIdx = grid.index(nx, ny);
        if (!candidates.has(nIdx) || seen.has(nIdx)) continue;
        seen.add(nIdx);
        stack.push(nIdx);
      }
    }
    components.push({ indices, areaM2: indices.size * grid.cell * grid.cell });
  }
  return components;
}

/**
 * 找喷洒中断区间（valve off 持续 >= minGapSec，且期间飞机仍在移动）。
 * @returns {Array<{startIdx:number,endIdx:number,durationSec:number,lengthM:number}>}
 */
export function findValveGaps(points, sprayState, minGapSec) {
  const gaps = [];
  const n = points.length;
  let offStart = -1;
  for (let i = 0; i <= n; i++) {
    const on = i < n && !!sprayState[i];
    if (!on && offStart === -1 && i > 0 && i < n) {
      // 前一点在喷洒 → 从 i 开始断喷
      if (sprayState[i - 1]) offStart = i;
    }
    if (on && offStart !== -1) {
      const startIdx = offStart;
      const endIdx = i - 1;
      const prevT = startIdx > 0 ? points[startIdx - 1].t : points[startIdx].t;
      const durationSec = points[endIdx].t - prevT;
      let lengthM = 0;
      for (let k = startIdx; k <= endIdx && k > 0; k++) {
        lengthM += Math.hypot(points[k].x - points[k - 1].x, points[k].y - points[k - 1].y);
      }
      if (durationSec >= minGapSec && lengthM > 0) {
        gaps.push({ startIdx, endIdx, durationSec, lengthM });
      }
      offStart = -1;
    }
  }
  return gaps;
}

/** 沿断喷区间（本应喷洒却关阀的航段）给栅格圆盘盖章 */
function buildGapCorridor(grid, points, gaps, swath) {
  const cells = new Set();
  for (const g of gaps) {
    for (let i = g.startIdx; i <= g.endIdx; i++) {
      for (const idx of grid.diskIndices(points[i].x, points[i].y, swath / 2, { exact: true })) {
        cells.add(idx);
      }
    }
  }
  return cells;
}

/** 找与某连通域在空间上相邻/重合的航迹点（用于给出时间窗与坐标证据） */
function evidenceForComponent(grid, component, points, swath, sprayState) {
  const r = Math.max(1, Math.round((swath * 1.5) / grid.cell));
  const radiusCells2 = r * r;
  let minT = Infinity, maxT = -Infinity;
  const touched = [];
  for (let pi = 0; pi < points.length; pi++) {
    const p = points[pi];
    const [cx, cy] = grid.cellAt(p.x, p.y);
    let hit = false;
    for (let dy = -r; dy <= r && !hit; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > radiusCells2) continue;
        const ix = cx + dx, iy = cy + dy;
        if (!grid.inBounds(ix, iy)) continue;
        if (component.indices.has(grid.index(ix, iy))) { hit = true; break; }
      }
    }
    if (hit) {
      if (p.t < minT) minT = p.t;
      if (p.t > maxT) maxT = p.t;
      touched.push(pi);
    }
  }
  const samples = [];
  if (touched.length) {
    const picks = [touched[0], touched[Math.floor(touched.length / 2)], touched[touched.length - 1]];
    for (const pi of [...new Set(picks)]) {
      samples.push({
        t: new Date(points[pi].t * 1000).toISOString(),
        lng: points[pi].lng,
        lat: points[pi].lat,
        spraying: !!sprayState?.[pi],
        alt: points[pi].alt,
      });
    }
  }
  return {
    timeWindow: Number.isFinite(minT)
      ? {
          start: new Date(minT * 1000).toISOString(),
          end: new Date(maxT * 1000).toISOString(),
        }
      : null,
    samples,
  };
}

function geometryOf(grid, component, project) {
  const centers = [...component.indices].map((i) => grid.center(i));
  const hull = centers.length >= 3 ? convexHull(centers) : centers;
  return {
    centroidLngLat: project(hull.reduce((a, c) => [a[0] + c[0], a[1] + c[1]], [0, 0]).map((v) => v / hull.length)),
    hullLngLat: hull.map(([x, y]) => project([x, y])),
  };
}

let findingSeq = 0;
function nextFindingId(kind) {
  findingSeq++;
  const prefix = {
    miss_interior: 'MI', miss_edge: 'ME', valve_gap: 'VG',
    overlap: 'OV', off_field: 'OF', nofly: 'NF',
  }[kind] || 'F';
  return `${prefix}-${String(findingSeq).padStart(3, '0')}`;
}

/** 测试间重置序号 */
export function resetFindingSeq() { findingSeq = 0; }

/**
 * 主识别函数。
 * @param {object} ctx
 */
export function detectFindings(ctx) {
  const {
    grid, project, points, sprayState, swath,
    outer, holes, noflyZones,
    fieldCells, sprayedCells, noflyCells, offFieldCells, boundaryLapCells,
    runSetPerCell, runIds,
    config,
  } = ctx;

  resetFindingSeq();
  const findings = [];
  const cellArea = grid.cell * grid.cell;

  // 1) 断喷区间 + 其"本应覆盖"走廊
  const valveGaps = sprayState ? findValveGaps(points, sprayState, config.minValveGapSec) : [];
  const gapCorridor = buildGapCorridor(grid, points, valveGaps, swath);

  // 2) 漏喷：地块内未喷洒的栅格
  const missCandidates = new Set();
  for (const idx of fieldCells) {
    if (!sprayedCells.has(idx)) missCandidates.add(idx);
  }
  const missComponents = labelComponents(grid, missCandidates)
    .filter((c) => c.areaM2 >= config.minFindingAreaM2);

  // 统计每个漏喷栅格"朝向地块外侧"的邻接边数：
  // 真正的边缘遗漏沿地块边界形成带状缺失，外侧边占比高；
  // "整行漏喷"虽然条带两端顶到边界，但外侧边只有两端两列，占比极低，判为内部遗漏。
  const outwardEdges = new Map();
  for (const idx of missCandidates) {
    const [ix, iy] = grid.coordOf(idx);
    let edges = 0;
    for (const [dx, dy] of NEIGHBORS4) {
      const nx = ix + dx, ny = iy + dy;
      if (!grid.inBounds(nx, ny) || !fieldCells.has(grid.index(nx, ny))) edges++;
    }
    outwardEdges.set(idx, edges);
  }

  for (const comp of missComponents) {
    let kind = 'miss_interior';
    let edgeEdges = 0;
    for (const idx of comp.indices) edgeEdges += outwardEdges.get(idx) ?? 0;
    // 沿边界 1 格宽的带状缺失，外侧边占比约 1/4；角部小块更高。整行漏喷接近 0。
    const boundaryRatio = edgeEdges / (comp.indices.size * 4);
    const touchesEdge = boundaryRatio >= 0.125;
    let matchedGap = null;
    if (!touchesEdge) {
      let inCorridor = 0;
      for (const idx of comp.indices) if (gapCorridor.has(idx)) inCorridor++;
      const ratio = inCorridor / comp.indices.size;
      if (ratio >= 0.5) {
        kind = 'valve_gap';
        // 选面积/时长最相关的断喷区间
        let best = null;
        for (const g of valveGaps) {
          const mid = points[Math.min(g.endIdx, points.length - 1)];
          const [cx, cy] = grid.cellAt(mid.x, mid.y);
          let near = false;
          for (let dy = -2; dy <= 2 && !near; dy++) {
            for (let dx = -2; dx <= 2; dx++) {
              if (comp.indices.has(grid.index(cx + dx, cy + dy))) { near = true; break; }
            }
          }
          if (near && (!best || g.durationSec > best.durationSec)) best = g;
        }
        matchedGap = best;
      }
    } else {
      kind = 'miss_edge';
    }

    const geo = geometryOf(grid, comp, project);
    const ev = evidenceForComponent(grid, comp, points, swath, sprayState);
    const type = FINDING_TYPES[kind];
    findings.push({
      id: nextFindingId(kind),
      kind,
      title: type.label,
      severity: type.severity,
      areaM2: Math.round(comp.areaM2 * 10) / 10,
      ...(matchedGap
        ? {
            lengthM: Math.round(matchedGap.lengthM),
            valveGapSec: Math.round(matchedGap.durationSec),
            timeWindow: {
              start: new Date((points[matchedGap.startIdx - 1]?.t ?? points[matchedGap.startIdx].t) * 1000).toISOString(),
              end: new Date(points[Math.min(matchedGap.endIdx + 1, points.length - 1)].t * 1000).toISOString(),
            },
          }
        : { timeWindow: ev.timeWindow }),
      location: geo.centroidLngLat,
      geometry: { type: 'polygon', lngLat: geo.hullLngLat },
      evidence: [
        `栅格化核验：连通域含 ${comp.indices.size} 个 ${grid.cell.toFixed(2)}m 栅格，面积 ${comp.areaM2.toFixed(1)} m²，无任何喷洒覆盖记录`,
        ...(matchedGap
          ? [`喷洒记录显示关阀 ${matchedGap.durationSec.toFixed(0)} 秒（约飞行 ${matchedGap.lengthM.toFixed(0)} m），该漏喷带位于断喷走廊内`]
          : touchesEdge
            ? ['漏喷区域与地块外边界相邻，判定为边缘遗漏']
            : ['漏喷区域四周均有喷洒覆盖，判定为内部遗漏']),
        ...(ev.timeWindow ? [`邻近航迹时间窗：${ev.timeWindow.start.slice(11, 19)}–${ev.timeWindow.end.slice(11, 19)} UTC`] : []),
      ],
      samples: ev.samples,
      appeal: { status: 'none', deadline: null },
    });
  }

  // 3) 重喷：地块内被 >=2 个作业行带覆盖
  const overlapCandidates = new Set();
  for (const idx of fieldCells) {
    const set = runSetPerCell.get(idx);
    if (set && set.size >= 2) overlapCandidates.add(idx);
  }
  for (const comp of labelComponents(grid, overlapCandidates).filter((c) => c.areaM2 >= config.minFindingAreaM2)) {
    const runIdsHere = new Set();
    let maxLayers = 1;
    for (const idx of comp.indices) {
      const set = runSetPerCell.get(idx);
      if (!set) continue;
      if (set.size > maxLayers) maxLayers = set.size;
      for (const r of set) runIdsHere.add(r);
    }
    const geo = geometryOf(grid, comp, project);
    const ev = evidenceForComponent(grid, comp, points, swath, sprayState);
    const type = FINDING_TYPES.overlap;
    findings.push({
      id: nextFindingId('overlap'),
      kind: 'overlap',
      title: type.label,
      severity: type.severity,
      areaM2: Math.round(comp.areaM2 * 10) / 10,
      maxLayers,
      distinctRunCount: runIdsHere.size,
      timeWindow: ev.timeWindow,
      location: geo.centroidLngLat,
      geometry: { type: 'polygon', lngLat: geo.hullLngLat },
      evidence: [
        `连通域 ${comp.areaM2.toFixed(1)} m² 被至少 2 个独立作业行带重复覆盖`,
        '重喷可能造成药害、药液浪费与亩用量超标',
      ],
      samples: ev.samples,
      appeal: { status: 'none', deadline: null },
    });
  }

  // 4) 界外喷洒 & 禁飞区喷洒（禁飞区优先归类）
  const grouped = {
    nofly: new Set(),
    off_field: new Set(),
  };
  for (const idx of sprayedCells) {
    if (noflyCells.has(idx)) grouped.nofly.add(idx);
    else if (!fieldCells.has(idx) && !boundaryLapCells?.has(idx)) grouped.off_field.add(idx);
  }
  for (const kind of ['nofly', 'off_field']) {
    const comps = labelComponents(grid, grouped[kind])
      .filter((c) => kind === 'nofly' || c.areaM2 >= config.minFindingAreaM2);
    for (const comp of comps) {
      const geo = geometryOf(grid, comp, project);
      const ev = evidenceForComponent(grid, comp, points, swath, sprayState);
      const type = FINDING_TYPES[kind];
      findings.push({
        id: nextFindingId(kind),
        kind,
        title: type.label,
        severity: type.severity,
        areaM2: Math.round(comp.areaM2 * 10) / 10,
        timeWindow: ev.timeWindow,
        location: geo.centroidLngLat,
        geometry: { type: 'polygon', lngLat: geo.hullLngLat },
        evidence: [
          kind === 'nofly'
            ? `禁飞区内检测到 ${comp.areaM2.toFixed(1)} m² 喷洒覆盖，属违规作业`
            : `地块边界外检测到 ${comp.areaM2.toFixed(1)} m² 喷洒覆盖，药液浪费且可能波及邻地`,
          ...(ev.samples.length ? [`喷洒航迹点示例：${ev.samples[0].lng.toFixed(6)}, ${ev.samples[0].lat.toFixed(6)} @ ${ev.samples[0].t.slice(11, 19)} UTC`] : []),
        ],
        samples: ev.samples,
        appeal: { status: 'none', deadline: null },
      });
    }
  }

  // 稳定排序：严重级别 → 面积降序 → id
  const sevRank = { critical: 0, major: 1, minor: 2 };
  findings.sort((a, b) =>
    (sevRank[a.severity] - sevRank[b.severity]) ||
    (b.areaM2 - a.areaM2) ||
    a.id.localeCompare(b.id));

  return { findings, valveGaps, missComponentCount: missComponents.length };
}
