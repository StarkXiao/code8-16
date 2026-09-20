// 地理与栅格单元测试
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeProjector, pointInRing, polygonArea, ringArea,
  distanceToRing, convexHull, haversineKm, centroidLngLat,
} from '../src/geo.js';
import { Grid } from '../src/grid.js';

test('等距圆柱投影：100m × 80m 矩形在赤道附近面积误差 <0.01%', () => {
  const [lng0, lat0] = [113.25, 23.1];
  const p = makeProjector(lng0, lat0);
  const ring = [[0, 0], [100, 0], [100, 80], [0, 80]]
    .map(([x, y]) => p.unproject([x, y]))
    .map(p.project);
  // 往返投影恒等
  const [lng, lat] = p.unproject([100, 80]);
  assert.ok(Math.abs(lng - (lng0 + 100 / p.mPerDegLng)) < 1e-12);
  assert.ok(Math.abs(lat - (lat0 + 80 / 111320)) < 1e-12);
  assert.ok(Math.abs(ringArea(ring) - 8000) / 8000 < 1e-6);
});

test('pointInRing 射线法', () => {
  const square = [[0, 0], [10, 0], [10, 10], [0, 10]];
  assert.equal(pointInRing([5, 5], square), true);
  assert.equal(pointInRing([-1, 5], square), false);
  assert.equal(pointInRing([11, 5], square), false);
  // 凹多边形（C 形）
  const cshape = [[0, 0], [10, 0], [10, 10], [8, 10], [8, 2], [2, 2], [2, 10], [0, 10]];
  assert.equal(pointInRing([1, 9], cshape), true);
  assert.equal(pointInRing([5, 9], cshape), false);
});

test('带洞多边形面积 = 外面积 - 洞面积', () => {
  const outer = [[0, 0], [100, 0], [100, 100], [0, 100]];
  const hole = [[20, 20], [80, 20], [80, 80], [20, 80]];
  assert.equal(polygonArea(outer, [hole]), 10000 - 3600);
});

test('distanceToRing', () => {
  const square = [[0, 0], [10, 0], [10, 10], [0, 10]];
  assert.equal(distanceToRing([5, 5], square), 5);
  assert.equal(distanceToRing([5, 0.6], square), 0.6);
});

test('convexHull：矩形 + 内部点返回 4 个角', () => {
  const pts = [[0, 0], [10, 0], [10, 10], [0, 10], [3, 3], [7, 5]];
  const hull = convexHull(pts);
  assert.equal(hull.length, 4);
});

test('convexHull：三点以下直接返回', () => {
  assert.equal(convexHull([[0, 0], [1, 1]]).length, 2);
  assert.equal(convexHull([[0, 0]]).length, 1);
});

test('haversine：约 111km 每纬度', () => {
  const km = haversineKm([0, 0], [0, 1]);
  assert.ok(Math.abs(km - 111.19) < 0.2);
});

test('centroidLngLat', () => {
  const [lng, lat] = centroidLngLat([[0, 0], [10, 0], [10, 10], [0, 10]]);
  assert.equal(lng, 5);
  assert.equal(lat, 5);
});

test('Grid：索引与坐标往返一致', () => {
  const g = new Grid({ minX: 0, minY: 0, maxX: 100, maxY: 80, cell: 1 });
  assert.equal(g.nx, 100);
  assert.equal(g.ny, 80);
  assert.equal(g.size, 8000);
  const [ix, iy] = g.cellAt(12.4, 7.9);
  assert.deepEqual([ix, iy], [12, 7]);
  const idx = g.index(12, 7);
  assert.deepEqual(g.coordOf(idx), [12, 7]);
  const [cx, cy] = g.center(idx);
  assert.deepEqual([cx, cy], [12.5, 7.5]);
});

test('Grid.diskIndices(exact)：半径 2m 圆盘以格心判定，覆盖 13 个 1m 栅格', () => {
  const g = new Grid({ minX: -5, minY: -5, maxX: 105, maxY: 105, cell: 1 });
  const cells = [...g.diskIndices(50.5, 50.5, 2, { exact: true })];
  // 中心格 + 4 个轴向邻居（距离 1）+ 8 个距离 sqrt2≈1.414 的对角邻居 = 13
  assert.equal(cells.length, 13);
});

test('Grid.diskIndices：越界自动裁剪', () => {
  const g = new Grid({ minX: 0, minY: 0, maxX: 10, maxY: 10, cell: 1 });
  const cells = [...g.diskIndices(0.5, 0.5, 2)];
  // 角落：只取四分之一圆盘
  assert.ok(cells.length < 13 && cells.length >= 4);
});
