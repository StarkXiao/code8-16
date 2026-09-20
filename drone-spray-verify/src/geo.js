// 地理计算：等距圆柱投影（小地块精度足够）、点在多边形内、面积、凸包等
export const M_PER_DEG_LAT = 111320;

/** 多边形顶点（经纬度）的算术中心，用作投影原点 */
export function centroidLngLat(ring) {
  let lng = 0, lat = 0;
  for (const [x, y] of ring) { lng += x; lat += y; }
  return [lng / ring.length, lat / ring.length];
}

/**
 * 以 (lng0, lat0) 为原点的局部米制投影。
 * 对单块农田（公里级）误差可忽略，核验面积/距离均在投影平面内计算。
 */
export function makeProjector(lng0, lat0) {
  const mPerDegLng = M_PER_DEG_LAT * Math.cos(lat0 * Math.PI / 180);
  return {
    origin: [lng0, lat0],
    mPerDegLng,
    project([lng, lat]) {
      return [(lng - lng0) * mPerDegLng, (lat - lat0) * M_PER_DEG_LAT];
    },
    unproject([x, y]) {
      return [lng0 + x / mPerDegLng, lat0 + y / M_PER_DEG_LAT];
    },
  };
}

/** 射线法判断点是否在环内（输入为投影后的米制坐标，环首尾不重复） */
export function pointInRing(p, ring) {
  const [px, py] = p;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersect =
      yi > py !== yj > py &&
      px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** 点是否在带洞多边形内 */
export function pointInPolygon(p, outer, holes = []) {
  if (!pointInRing(p, outer)) return false;
  for (const h of holes) {
    if (pointInRing(p, h)) return false;
  }
  return true;
}

/** 鞋带公式求环面积（投影坐标，m²） */
export function ringArea(ring) {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s) / 2;
}

export function polygonArea(outer, holes = []) {
  let a = ringArea(outer);
  for (const h of holes) a -= ringArea(h);
  return a;
}

export function dist2D(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/** 经纬度 haversine 距离（km），用于统计航迹总里程 */
export function haversineKm(a, b) {
  const R = 6371;
  const dLat = (b[1] - a[1]) * Math.PI / 180;
  const dLng = (b[0] - a[0]) * Math.PI / 180;
  const la1 = a[1] * Math.PI / 180;
  const la2 = b[1] * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** 点到线段的最短距离（投影平面） */
export function pointSegmentDistance(p, a, b) {
  const [px, py] = p;
  const [ax, ay] = a;
  const [bx, by] = b;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** 点到环（边界）的最短距离 */
export function distanceToRing(p, ring) {
  let min = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const d = pointSegmentDistance(p, ring[i], ring[(i + 1) % ring.length]);
    if (d < min) min = d;
  }
  return min;
}

/** Andrew 单调链凸包，返回闭合多边形（输入 [[x,y],...]） */
export function convexHull(points) {
  const pts = [...new Map(points.map((p) => [p.join(','), p])).values()]
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length <= 2) return pts;
  const cross = (o, a, b) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}
