import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alignTrackWithSpray } from '../src/align.js';
import { createProjection } from '../src/geo.js';

const proj = createProjection(45, 126);
const T0 = Date.parse('2026-09-20T00:00:00Z');

function trackPoint(offsetSec, lat = 45, lon = 126) {
  return { t: T0 + offsetSec * 1000, lat, lon, alt: 10, speed: 5 };
}

test('时间对齐：最近邻匹配开关状态，容差外标记未知', () => {
  const track = [trackPoint(0), trackPoint(1), trackPoint(10)];
  const spray = [
    { t: T0 + 200, sprayOn: true, flowLpm: 3 }, // 与 0s、1s 点相差 <1.5s
    { t: T0 + 1200, sprayOn: true, flowLpm: 3 },
    // 10s 点 8.8s 内无记录 → 未知
  ];
  const { points, segments, issues } = alignTrackWithSpray(track, spray, proj);
  assert.equal(points[0].sprayOn, true);
  assert.equal(points[1].sprayOn, true);
  assert.equal(points[2].sprayOn, null);
  assert.equal(segments[0].type, 'spray');
  assert.equal(segments[1].type, 'unknown'); // 既超航迹缺口阈值，喷洒状态也未知
  assert.ok(issues.some((i) => i.message.includes('未能对齐')));
});

test('航迹缺口切段：间隔超阈值记为 unknown 而不是 spray', () => {
  const track = [trackPoint(0), trackPoint(1), trackPoint(8), trackPoint(9)];
  const spray = [];
  for (let s = 0; s <= 9; s++) spray.push({ t: T0 + s * 1000, sprayOn: true, flowLpm: 3 });
  const { segments } = alignTrackWithSpray(track, spray, proj);
  assert.deepEqual(segments.map((s) => s.type), ['spray', 'unknown', 'spray']);
});

test('喷洒记录缺失时整段为 unknown，不会误判为漏喷', () => {
  const track = [trackPoint(0), trackPoint(1), trackPoint(2)];
  const spray = [{ t: T0 - 60_000, sprayOn: true, flowLpm: 3 }]; // 1 分钟前，超容差
  const { segments } = alignTrackWithSpray(track, spray, proj);
  assert.ok(segments.every((s) => s.type === 'unknown'));
});
