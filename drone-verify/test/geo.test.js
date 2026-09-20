import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createProjection,
  polygonAreaM2,
  pointInPolygon,
  distPointSegment,
  convexHull,
  buildGrid,
  connectedRegions,
} from '../src/geo.js';

test('投影往返误差可忽略', () => {
  const proj = createProjection(45.752, 126.631);
  const [x, y] = proj.toXY(45.76, 126.64);
  const [lat, lon] = proj.toLatLon(x, y);
  assert.ok(Math.abs(lat - 45.76) < 1e-9);
  assert.ok(Math.abs(lon - 126.64) < 1e-9);
});

test('投影距离：纬度 1° ≈ 110.54km，经度按纬度缩放', () => {
  const proj = createProjection(45, 120);
  const [x1] = proj.toXY(45, 121);
  const [, y1] = proj.toXY(46, 120);
  assert.ok(Math.abs(x1 - 111320 * Math.cos(Math.PI / 4)) < 1);
  assert.ok(Math.abs(y1 - 110540) < 1);
});

test('多边形面积与点在多边形', () => {
  const square = [[0, 0], [100, 0], [100, 50], [0, 50]];
  assert.equal(polygonAreaM2(square), 5000);
  assert.ok(pointInPolygon(50, 25, square));
  assert.ok(!pointInPolygon(150, 25, square));
  assert.ok(!pointInPolygon(50, -1, square));
});

test('点到线段距离', () => {
  assert.equal(distPointSegment(0, 5, -10, 0, 10, 0), 5);
  assert.equal(distPointSegment(20, 0, -10, 0, 10, 0), 10); // 落在线段外取端点
});

test('凸包面积等于单位正方形', () => {
  const hull = convexHull([[0, 0], [1, 0], [1, 1], [0, 1], [0.5, 0.5]]);
  assert.equal(hull.length, 5); // 闭合
  assert.equal(polygonAreaM2(hull), 1);
});

test('栅格：边界余量会缩小有效核验区', () => {
  const square = [[0, 0], [100, 0], [100, 100], [0, 100]];
  const grid = buildGrid(square, { resolution: 1, margin: 10 });
  let insideCount = 0;
  let fieldCount = 0;
  for (let i = 0; i < grid.inside.length; i++) {
    insideCount += grid.inside[i];
    fieldCount += grid.inField[i];
  }
  assert.equal(fieldCount, 10000);
  assert.equal(insideCount, 80 * 80); // 四边各内缩 10m
});

test('连通域：两个分离区域分别统计，过小区域被忽略', () => {
  const grid = { originX: 0, originY: 0, resolution: 1, cols: 20, rows: 10 };
  const mask = new Uint8Array(200);
  // 区域 A：3×3 = 9㎡
  for (let j = 1; j <= 3; j++) for (let i = 1; i <= 3; i++) mask[j * 20 + i] = 1;
  // 区域 B：2×2 = 4㎡
  for (let j = 6; j <= 7; j++) for (let i = 15; i <= 16; i++) mask[j * 20 + i] = 1;
  // 噪声：1㎡
  mask[5 * 20 + 10] = 1;
  const regions = connectedRegions(mask, grid, { minAreaM2: 2 });
  assert.equal(regions.length, 2);
  const areas = regions.map((r) => r.areaM2).sort((a, b) => a - b);
  assert.deepEqual(areas, [4, 9]);
});
