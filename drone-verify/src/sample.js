/**
 * sample.js —— 生成一套典型作业样例数据，用于演示与端到端测试。
 *
 * 场景：160m × 96m 水稻田（约 23 亩），喷幅 8m，12 条往返航线，航速 5m/s。
 * 人为植入 4 类问题：
 *  1. 漏喷：第 5 条航线（y=36）x∈[60,100] 喷头堵塞未喷（约 320㎡）
 *  2. 重喷：第 7 条航线后误判补飞一段 y=54、x∈[120,150]（约 240㎡ 重复覆盖）
 *  3. 数据缺口：第 10 条航线（y=76）RTK 丢点，x∈[70,100] 航迹缺失（喷洒记录仍在）
 *  4. 越界喷洒：第 2 条航线在地块外提前 6m 开喷
 * 另生成 spray-corrected.csv：飞手申诉时补交的"正确喷洒记录"，
 * 证明漏喷段实际已开喷（原记录因日志同步丢行），用于演示申诉-复核闭环。
 */

import { createProjection } from './geo.js';

const ORIGIN_LAT = 45.752;
const ORIGIN_LON = 126.631;
const T0 = Date.parse('2026-09-20T01:00:00Z');
const FLOW_LPM = 3.6; // 5m/s × 8m 喷幅 → 3.6 亩/min，对应 1.0 L/亩

export function generateSample() {
  const proj = createProjection(ORIGIN_LAT, ORIGIN_LON);
  const toLatLon = (x, y) => proj.toLatLon(x, y);

  const task = {
    taskId: 'TASK-2026-0920-01',
    crop: '水稻',
    operator: '示例飞防队',
    boundary: [
      [0, 0],
      [160, 0],
      [160, 96],
      [0, 96],
    ].map(([x, y]) => {
      const [lat, lon] = toLatLon(x, y);
      return [round7(lat), round7(lon)];
    }),
    swathWidthM: 8,
    plannedDosageLPerMu: 1.0,
    plannedSpeedMps: 5,
  };

  const legs = buildLegs(false);
  const { track, spray } = simulate(legs, toLatLon);
  const correctedSpray = simulate(buildLegs(true), toLatLon).spray;

  return {
    taskJson: JSON.stringify(task, null, 2),
    trackCsv: toTrackCsv(track),
    sprayCsv: toSprayCsv(spray),
    sprayCorrectedCsv: toSprayCsv(correctedSpray),
  };
}

function buildLegs(corrected) {
  const legs = [];
  const turn = (x0, y0, x1, y1) => {
    const d = Math.hypot(x1 - x0, y1 - y0);
    legs.push({ x0, y0, x1, y1, spray: false, dur: Math.max(1, Math.ceil(d / 4)) });
  };
  const swath = (x0, y, x1, opts = {}) =>
    legs.push({ x0, y0: y, x1, y1: y, spray: true, ...opts });

  swath(0, 4, 160);
  turn(160, 4, 166, 12);
  swath(166, 12, 0); // 问题4：地块外提前 6m 开喷
  turn(0, 12, 0, 20);
  swath(0, 20, 160);
  turn(160, 20, 160, 28);
  swath(160, 28, 0);
  turn(0, 28, 0, 36);
  swath(0, 36, 60);
  // 问题1：漏喷段（申诉场景中，corrected 版本此处实际为开喷）
  legs.push({ x0: 60, y0: 36, x1: 100, y1: 36, spray: corrected });
  swath(100, 36, 160);
  turn(160, 36, 160, 44);
  swath(160, 44, 0);
  turn(0, 44, 0, 52);
  swath(0, 52, 160);
  turn(160, 52, 150, 54);
  swath(150, 54, 120); // 问题2：误判补飞，与前后航线重叠
  turn(120, 54, 160, 60);
  swath(160, 60, 0);
  turn(0, 60, 0, 68);
  swath(0, 68, 160);
  turn(160, 68, 160, 76);
  swath(160, 76, 0, { dropTrack: true }); // 问题3：RTK 丢点
  turn(0, 76, 0, 84);
  swath(0, 84, 160);
  turn(160, 84, 160, 92);
  swath(160, 92, 0);
  return legs;
}

function simulate(legs, toLatLon) {
  const track = [];
  const spray = [];
  let clock = 0; // 秒
  const emit = (tSec, x, y, speed, sprayOn, drop) => {
    const t = T0 + tSec * 1000;
    spray.push({ t, sprayOn, flowLpm: sprayOn ? FLOW_LPM : 0 });
    if (drop && x > 70 && x < 100) return; // 模拟 RTK 丢点：航迹缺失但喷洒记录仍在
    const [lat, lon] = toLatLon(x, y);
    track.push({ t, lat: round7(lat), lon: round7(lon), alt: 15, speed: Math.round(speed * 100) / 100 });
  };
  for (const leg of legs) {
    const dist = Math.hypot(leg.x1 - leg.x0, leg.y1 - leg.y0);
    const dur = leg.dur ?? dist / 5;
    const steps = Math.max(1, Math.round(dur));
    for (let s = 0; s < steps; s++) {
      const k = s / steps;
      emit(
        clock + s,
        leg.x0 + (leg.x1 - leg.x0) * k,
        leg.y0 + (leg.y1 - leg.y0) * k,
        dist / dur,
        leg.spray,
        leg.dropTrack
      );
    }
    clock += steps;
  }
  const last = legs[legs.length - 1];
  emit(clock, last.x1, last.y1, 0, last.spray, false);
  return { track, spray };
}

function toTrackCsv(track) {
  const lines = ['ts,lat,lon,alt_m,speed_mps'];
  for (const p of track)
    lines.push(`${new Date(p.t).toISOString()},${p.lat},${p.lon},${p.alt},${p.speed}`);
  return lines.join('\n') + '\n';
}

function toSprayCsv(spray) {
  const lines = ['ts,spray_on,flow_lpm'];
  for (const r of spray)
    lines.push(`${new Date(r.t).toISOString()},${r.sprayOn ? 1 : 0},${r.flowLpm}`);
  return lines.join('\n') + '\n';
}

function round7(n) {
  return Math.round(n * 1e7) / 1e7;
}
