/**
 * geo.js —— 平面几何与栅格化基础库（零依赖）。
 *
 * 坐标约定：外部输入为 WGS84 经纬度，进入分析前统一投影到
 * 以作业区中心为原点的局部平面坐标（单位：米）。植保地块
 * 尺度（通常 < 2km）下等距圆柱近似的畸变可忽略。
 */

export const M2_PER_MU = 666.6667;

/** 经纬度 → 局部平面坐标（米）的投影器 */
export function createProjection(lat0, lon0) {
  const kx = Math.cos((lat0 * Math.PI) / 180) * 111320;
  const ky = 110540;
  return {
    toXY(lat, lon) {
      return [(lon - lon0) * kx, (lat - lat0) * ky];
    },
    toLatLon(x, y) {
      return [lat0 + y / ky, lon0 + x / kx];
    },
  };
}

/** 鞋带公式求多边形面积（㎡），ring 为 [[x,y],...]，不要求闭合 */
export function polygonAreaM2(ring) {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s) / 2;
}

/** 射线法判断点是否在多边形内（边界上视为在内） */
export function pointInPolygon(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (onSegment(x, y, xi, yi, xj, yj)) return true;
    const intersect =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function onSegment(px, py, ax, ay, bx, by) {
  const cross = (px - ax) * (by - ay) - (py - ay) * (bx - ax);
  if (Math.abs(cross) > 1e-9) return false;
  const dot = (px - ax) * (bx - ax) + (py - ay) * (by - ay);
  if (dot < 0) return false;
  const lenSq = (bx - ax) ** 2 + (by - ay) ** 2;
  return dot <= lenSq;
}

/** 点到线段的距离（米） */
export function distPointSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = 0;
  if (lenSq > 0) {
    t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
  }
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/** 点到多边形边界的最短距离（米） */
export function distToPolygonBoundary(x, y, ring) {
  let min = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const d = distPointSegment(x, y, ring[j][0], ring[j][1], ring[i][0], ring[i][1]);
    if (d < min) min = d;
  }
  return min;
}

/** Andrew monotone chain 凸包，返回闭合 ring（首尾相同） */
export function convexHull(points) {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return [...pts, pts[0]].filter(Boolean);
  const cross = (o, a, b) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0)
      lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0)
      upper.pop();
    upper.push(p);
  }
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
  hull.push(hull[0]);
  return hull;
}

/**
 * 在地块多边形上构建核验栅格。
 * @param ringXY 地块边界（平面坐标）
 * @param resolution 栅格边长（米），默认 0.5
 * @param margin 边界安全余量（米）：距边界不足 margin 的格子不计入核验区
 * @param pad 栅格外延（米），用于捕捉越界喷洒
 * @returns {{originX,originY,resolution,cols,rows,inside:Uint8Array,inField:Uint8Array}}
 *   inside=1 表示该格子属于"有效核验区"（地块内且满足边界余量）；
 *   inField=1 表示格子在地块边界内（不含余量要求），用于区分真正的越界喷洒
 */
export function buildGrid(ringXY, { resolution = 0.5, margin = 0, pad = 0 } = {}) {
  const xs = ringXY.map((p) => p[0]);
  const ys = ringXY.map((p) => p[1]);
  const minX = Math.min(...xs) - pad;
  const minY = Math.min(...ys) - pad;
  const maxX = Math.max(...xs) + pad;
  const maxY = Math.max(...ys) + pad;
  const cols = Math.ceil((maxX - minX) / resolution);
  const rows = Math.ceil((maxY - minY) / resolution);
  const inside = new Uint8Array(cols * rows);
  const inField = new Uint8Array(cols * rows);
  for (let j = 0; j < rows; j++) {
    const cy = minY + (j + 0.5) * resolution;
    for (let i = 0; i < cols; i++) {
      const cx = minX + (i + 0.5) * resolution;
      if (pointInPolygon(cx, cy, ringXY)) {
        inField[j * cols + i] = 1;
        if (distToPolygonBoundary(cx, cy, ringXY) >= margin) inside[j * cols + i] = 1;
      }
    }
  }
  return { originX: minX, originY: minY, resolution, cols, rows, inside, inField };
}

/**
 * 把一段航迹按半喷幅缓冲栅格化，对每个被覆盖的格子回调 visit(i, j)。
 */
export function rasterizeSegment(grid, ax, ay, bx, by, halfWidth, visit) {
  const { originX, originY, resolution, cols, rows } = grid;
  const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - halfWidth - originX) / resolution));
  const i1 = Math.min(cols - 1, Math.floor((Math.max(ax, bx) + halfWidth - originX) / resolution));
  const j0 = Math.max(0, Math.floor((Math.min(ay, by) - halfWidth - originY) / resolution));
  const j1 = Math.min(rows - 1, Math.floor((Math.max(ay, by) + halfWidth - originY) / resolution));
  for (let j = j0; j <= j1; j++) {
    const cy = originY + (j + 0.5) * resolution;
    for (let i = i0; i <= i1; i++) {
      const cx = originX + (i + 0.5) * resolution;
      if (distPointSegment(cx, cy, ax, ay, bx, by) <= halfWidth) visit(i, j);
    }
  }
}

/**
 * 布尔栅格的 4-邻域连通域提取。
 * @returns 区域数组 [{areaM2, cells, centroid:[x,y], hull:[[x,y]...] 闭合凸包}]
 *   面积小于 minAreaM2 的区域被忽略（栅格锯齿噪声）
 */
export function connectedRegions(mask, grid, { minAreaM2 = 2 } = {}) {
  const { cols, rows, resolution, originX, originY } = grid;
  const labels = new Int32Array(cols * rows).fill(-1);
  const regions = [];
  const stack = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || labels[start] >= 0) continue;
    const cells = [];
    stack.push(start);
    labels[start] = regions.length;
    while (stack.length) {
      const cur = stack.pop();
      cells.push(cur);
      const ci = cur % cols;
      const cj = Math.floor(cur / cols);
      const neighbors = [
        ci > 0 ? cur - 1 : -1,
        ci < cols - 1 ? cur + 1 : -1,
        cj > 0 ? cur - cols : -1,
        cj < rows - 1 ? cur + cols : -1,
      ];
      for (const nb of neighbors) {
        if (nb >= 0 && mask[nb] && labels[nb] < 0) {
          labels[nb] = regions.length;
          stack.push(nb);
        }
      }
    }
    const areaM2 = cells.length * resolution * resolution;
    if (areaM2 < minAreaM2) continue;
    // 用全部格子的角点求凸包作为区域轮廓
    const corners = [];
    let sx = 0;
    let sy = 0;
    for (const c of cells) {
      const ci = c % cols;
      const cj = Math.floor(c / cols);
      const x0 = originX + ci * resolution;
      const y0 = originY + cj * resolution;
      sx += x0 + resolution / 2;
      sy += y0 + resolution / 2;
      corners.push([x0, y0], [x0 + resolution, y0], [x0, y0 + resolution], [x0 + resolution, y0 + resolution]);
    }
    regions.push({
      areaM2,
      cellCount: cells.length,
      centroid: [sx / cells.length, sy / cells.length],
      hull: convexHull(corners),
    });
  }
  return regions;
}
