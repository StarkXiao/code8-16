/**
 * coverage.js —— 覆盖分析：把有效喷洒段栅格化，识别漏喷区与重喷区。
 *
 * 判定口径（栅格分辨率默认 0.5m）：
 *  - 漏喷区：有效核验区内，覆盖次数 = 0 的连通区域
 *  - 重喷区：有效核验区内，覆盖次数 ≥ 2 的连通区域
 *  - 数据缺口区：unknown 航段缓冲带，从核验区中剔除（不算漏也不算喷）
 *  - 越界喷洒：地块边界外的覆盖（提示项，涉及药害漂移责任）
 */

import { buildGrid, rasterizeSegment, connectedRegions, pointInPolygon, distToPolygonBoundary } from './geo.js';

export const DEFAULT_COVERAGE = {
  resolutionM: 0.5,
  minRegionAreaM2: 2, // 小于该面积的区域视为栅格噪声
  boundaryMarginM: null, // 边界安全余量，默认取半个喷幅
};

export function analyzeCoverage(task, aligned, boundaryXY, opts = {}) {
  const cfg = { ...DEFAULT_COVERAGE, ...opts };
  const halfSwath = task.swathWidthM / 2;
  const margin = cfg.boundaryMarginM ?? halfSwath;

  const grid = buildGrid(boundaryXY, {
    resolution: cfg.resolutionM,
    margin,
    pad: task.swathWidthM, // 外延一个喷幅，捕捉越界喷洒
  });
  const { cols, rows, inside, inField } = grid;
  const counts = new Uint8Array(cols * rows);
  const unknown = new Uint8Array(cols * rows);

  // 把连续的 spray 段合并为"喷洒趟次"：趟次内部用 set 语义栅格化（同一趟
  // 相邻线段的胶囊缓冲区天然重叠，不能算重喷），趟次之间才累加覆盖次数。
  const passes = [];
  let current = [];
  for (const seg of aligned.segments) {
    if (seg.type === 'spray') {
      current.push(seg);
    } else {
      if (seg.type === 'unknown') {
        const a = aligned.points[seg.a];
        const b = aligned.points[seg.b];
        rasterizeSegment(grid, a.x, a.y, b.x, b.y, halfSwath, (i, j) => {
          unknown[j * cols + i] = 1;
        });
      }
      if (current.length) {
        passes.push(current);
        current = [];
      }
    }
  }
  if (current.length) passes.push(current);

  const passMask = new Uint8Array(cols * rows);
  const spillMask = new Uint8Array(cols * rows); // 中心线在地块外的喷洒段
  for (const pass of passes) {
    passMask.fill(0);
    for (const seg of pass) {
      const a = aligned.points[seg.a];
      const b = aligned.points[seg.b];
      rasterizeSegment(grid, a.x, a.y, b.x, b.y, halfSwath, (i, j) => {
        passMask[j * cols + i] = 1;
      });
      // 越界判定看中心线：贴着边界正常作业时喷幅自然外溢，不算越界；
      // 只有飞机本身在地块外（>0.5m 容差）开喷，才计入越界喷洒
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      if (!pointInPolygon(mx, my, boundaryXY) && distToPolygonBoundary(mx, my, boundaryXY) > 0.5) {
        rasterizeSegment(grid, a.x, a.y, b.x, b.y, halfSwath, (i, j) => {
          spillMask[j * cols + i] = 1;
        });
      }
    }
    for (let idx = 0; idx < counts.length; idx++) {
      if (passMask[idx] && counts[idx] < 255) counts[idx]++;
    }
  }

  // 汇总指标
  let validCells = 0;
  let coveredCells = 0;
  let missedCells = 0;
  let repeatedCells = 0;
  let unknownCells = 0;
  let outsideCells = 0;
  let sprayedCells = 0; // 所有被喷到的格子（含边界余量带与越界部分），是亩用量的分母
  const missedMask = new Uint8Array(cols * rows);
  const repeatedMask = new Uint8Array(cols * rows);
  for (let idx = 0; idx < counts.length; idx++) {
    if (counts[idx] > 0) sprayedCells++;
    const inValid = inside[idx] === 1;
    if (unknown[idx] && inValid) {
      unknownCells++;
      continue; // 数据缺口格子不参与漏喷/重喷判定
    }
    if (inValid) {
      validCells++;
      if (counts[idx] === 0) {
        missedCells++;
        missedMask[idx] = 1;
      } else {
        coveredCells++;
        if (counts[idx] >= 2) {
          repeatedCells++;
          repeatedMask[idx] = 1;
        }
      }
    } else if (spillMask[idx] && !inField[idx]) {
      outsideCells++; // 中心线在地块外的喷洒（边界余量带不算越界）
    }
  }
  const cellArea = grid.resolution ** 2;
  const toArea = (n) => n * cellArea;

  // 连通域聚合
  const regionOpts = { minAreaM2: cfg.minRegionAreaM2 };
  const missedRegions = connectedRegions(missedMask, grid, regionOpts);
  const repeatedRegions = connectedRegions(repeatedMask, grid, regionOpts);

  return {
    grid,
    counts,
    metrics: {
      validAreaM2: toArea(validCells),
      coveredAreaM2: toArea(coveredCells),
      missedAreaM2: toArea(missedCells),
      repeatedAreaM2: toArea(repeatedCells),
      unknownAreaM2: toArea(unknownCells),
      outsideSprayAreaM2: toArea(outsideCells),
      sprayedAreaM2: toArea(sprayedCells),
      missedRate: validCells ? missedCells / validCells : 0,
      repeatedRate: validCells ? repeatedCells / validCells : 0,
      unknownRate: validCells + unknownCells ? unknownCells / (validCells + unknownCells) : 0,
      coverageRate: validCells ? coveredCells / validCells : 0,
    },
    missedRegions,
    repeatedRegions,
  };
}
