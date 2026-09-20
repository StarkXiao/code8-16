import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeCoverage } from '../src/coverage.js';

const TASK = { swathWidthM: 10 };
const FIELD_40x20 = [[0, 0], [40, 0], [40, 20], [0, 20]];

/**
 * 用航段列表构造 aligned 结构。
 * legs: [{from:[x,y], to:[x,y], type:'spray'|'off', gapAfterSec?}]
 * 相邻航段连接处：时间间隔 >3s 自动判为 unknown（模拟航迹缺口）。
 */
function makeAligned(legs) {
  const points = [];
  const legOfPoint = [];
  let t = 0;
  for (const leg of legs) {
    const [x0, y0] = leg.from;
    const [x1, y1] = leg.to;
    const dist = Math.hypot(x1 - x0, y1 - y0);
    const n = Math.max(1, Math.round(dist / 5));
    for (let s = 0; s <= n; s++) {
      const k = s / n;
      points.push({ x: x0 + (x1 - x0) * k, y: y0 + (y1 - y0) * k, t: t + s * 1000 });
      legOfPoint.push(leg);
    }
    t += (n + (leg.gapAfterSec ?? 0)) * 1000;
  }
  const segments = [];
  for (let i = 0; i < points.length - 1; i++) {
    const dt = points[i + 1].t - points[i].t;
    const sameLeg = legOfPoint[i] === legOfPoint[i + 1];
    segments.push({
      a: i,
      b: i + 1,
      type: dt > 3000 ? 'unknown' : sameLeg ? legOfPoint[i].type : 'off',
      t0: points[i].t,
      t1: points[i + 1].t,
    });
  }
  return { points, segments };
}

test('回归：同一趟内相邻线段的胶囊缓冲区重叠不得计为重喷', () => {
  // 一条 100m 直线趟，20 个连续 spray 段
  const aligned = makeAligned([{ from: [0, 10], to: [100, 10], type: 'spray' }]);
  const field = [[0, 0], [100, 0], [100, 20], [0, 20]];
  const r = analyzeCoverage(TASK, aligned, field);
  assert.equal(r.metrics.repeatedAreaM2, 0);
  assert.ok(r.metrics.coverageRate > 0.99);
});

test('漏喷：喷洒中断区域被检出，面积与理论值一致', () => {
  // 两条航线 y=5、y=15（喷幅 10 正好铺满）；第二条中段 x∈[10,30] 未喷
  const aligned = makeAligned([
    { from: [0, 5], to: [40, 5], type: 'spray' },
    { from: [0, 15], to: [10, 15], type: 'spray' },
    { from: [10, 15], to: [30, 15], type: 'off' },
    { from: [30, 15], to: [40, 15], type: 'spray' },
  ]);
  const r = analyzeCoverage(TASK, aligned, FIELD_40x20);
  // 理论漏喷带：x∈[15,25] 附近（胶囊端盖为半圆形，边缘处略宽）× 有效区 y∈[10,15]
  assert.ok(r.metrics.missedAreaM2 > 40 && r.metrics.missedAreaM2 < 75, `漏喷面积 ${r.metrics.missedAreaM2}`);
  assert.equal(r.missedRegions.length, 1);
  // 漏喷区质心应在 (20, 12.5) 附近
  const [cx, cy] = r.missedRegions[0].centroid;
  assert.ok(Math.abs(cx - 20) < 1 && Math.abs(cy - 12.5) < 1);
});

test('重喷：同一航线飞两遍，整个有效区计为重喷', () => {
  const aligned = makeAligned([
    { from: [0, 10], to: [40, 10], type: 'spray' },
    { from: [40, 10], to: [0, 10], type: 'spray' }, // 掉头沿原线再喷一遍
  ]);
  const r = analyzeCoverage(TASK, aligned, FIELD_40x20);
  // 有效区 x∈[5,35] × y∈[5,15] = 300㎡
  assert.ok(Math.abs(r.metrics.repeatedAreaM2 - 300) < 6, `重喷面积 ${r.metrics.repeatedAreaM2}`);
  assert.ok(r.metrics.missedAreaM2 < 1);
});

test('数据缺口：航迹中断带不计入漏喷，单独记为 unknown', () => {
  const aligned = makeAligned([
    { from: [0, 10], to: [15, 10], type: 'spray', gapAfterSec: 8 },
    { from: [25, 10], to: [40, 10], type: 'spray' },
  ]);
  const r = analyzeCoverage(TASK, aligned, FIELD_40x20);
  assert.ok(r.metrics.unknownAreaM2 > 40, `缺口面积 ${r.metrics.unknownAreaM2}`);
  // 缺口带从有效核验区剔除，漏喷面积应远小于缺口面积
  assert.ok(r.metrics.missedAreaM2 < 5, `漏喷面积 ${r.metrics.missedAreaM2}`);
});

test('越界：中心线在地块外的喷洒才计越界，贴边作业不计', () => {
  const onBoundary = makeAligned([{ from: [0, 10], to: [40, 10], type: 'spray' }]);
  const r1 = analyzeCoverage(TASK, onBoundary, FIELD_40x20);
  assert.equal(r1.metrics.outsideSprayAreaM2, 0);

  const outside = makeAligned([
    { from: [0, 10], to: [40, 10], type: 'spray' },
    { from: [40, 10], to: [48, 10], type: 'spray' }, // 冲出地块 8m 仍开喷
  ]);
  const r2 = analyzeCoverage(TASK, outside, FIELD_40x20);
  assert.ok(r2.metrics.outsideSprayAreaM2 > 20, `越界面积 ${r2.metrics.outsideSprayAreaM2}`);
});
