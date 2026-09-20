// 核验引擎集成测试：构造可控的小地块任务，验证漏喷/重喷/界外/断喷的检出与判定
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { verify } from '../src/verify.js';
import {
  submitAppeal, reviewAppeal, withdrawAppeal, AppealStore, AppealError,
} from '../src/appeals.js';
import { buildMission, buildCleanMission } from '../src/demo.js';

function tmpStore() {
  return new AppealStore(fs.mkdtempSync(path.join(os.tmpdir(), 'dsv-appeals-')));
}
const STORE = tmpStore();

// ---- 小型合成任务工具 ----
const ORIGIN = [113.0, 23.0];
const M_PER_DEG_LAT = 111320;
function xy(n) {
  const mPerDegLng = M_PER_DEG_LAT * Math.cos(ORIGIN[1] * Math.PI / 180);
  return [ORIGIN[0] + n[0] / mPerDegLng, ORIGIN[1] + n[1] / M_PER_DEG_LAT];
}

let baseT = Date.UTC(2026, 8, 1, 0, 0, 0) / 1000;

/**
 * 生成在 40m×40m 方块上蛇形作业的任务。
 * opts: { skipYs:[行y], doubleYs:[行y], gapOnY:{y,x0,x1}, extendLast:m, config:{} }
 */
function makeTask(opts = {}) {
  const W = 40, H = 40, swath = 4;
  const points = [];
  let t = baseT;
  const ys = [];
  for (let y = 2; y < H; y += 4) ys.push(y);
  const push = (x, y, spraying) => {
    const [lng, lat] = xy([x, y]);
    points.push({
      t: new Date(t * 1000).toISOString(),
      lng: Number(lng.toFixed(9)), lat: Number(lat.toFixed(9)),
      alt: 2.5, speed: 2, spraying,
    });
  };
  let prev = null;
  const flyTo = (x, y, spraying) => {
    if (!prev) { prev = [x, y]; push(x, y, false); return; }
    const d = Math.hypot(x - prev[0], y - prev[1]);
    for (let s = 1; s <= Math.round(d / 2); s++) {
      t += 1;
      push(prev[0] + (x - prev[0]) * (s / Math.round(d / 2)),
           prev[1] + (y - prev[1]) * (s / Math.round(d / 2)), false);
    }
    prev = [x, y];
  };
  ys.forEach((y, li) => {
    if (opts.skipYs?.includes(y)) return;
    const ltr = li % 2 === 0;
    const x0 = ltr ? 0 : W;
    const x1 = (ltr ? W : 0) + (opts.extendLast && li === ys.length - 1 ? -opts.extendLast : 0);
    flyTo(x0, y, false);
    const dir = x1 >= x0 ? 1 : -1;
    for (let x = x0; dir > 0 ? x <= x1 : x >= x1; x += dir * 2) {
      t += 1;
      let on = true;
      if (opts.gapOnY && opts.gapOnY.y === y && x > opts.gapOnY.x0 && x < opts.gapOnY.x1) on = false;
      push(x, y, on);
    }
  });
  for (const y of opts.doubleYs ?? []) {
    flyTo(0, y, false);
    for (let x = 0; x <= W; x += 2) { t += 1; push(x, y, true); }
  }
  return {
    reportId: `T-${Math.random().toString(36).slice(2, 8)}`,
    mission: { id: 't', name: '合成任务', operatorName: '测试飞手' },
    field: { name: '方田', polygon: { outer: [xy([0, 0]), xy([W, 0]), xy([W, H]), xy([0, H])] } },
    spray: { swath },
    track: { points },
    config: opts.config ?? {},
  };
}

const kindsOf = (r) => r.findings.map((f) => f.kind).sort();

test('满幅正常作业：PASS、无问题、覆盖率≈100%', () => {
  const r = verify(makeTask());
  assert.equal(r.conclusion.result, 'PASS');
  assert.equal(r.findings.length, 0);
  assert.ok(r.metrics.coverageRatio > 0.99, `覆盖率 ${r.metrics.coverageRatio}`);
  assert.equal(r.originalConclusion.result, 'PASS');
});

test('跳过一整行：检出 miss_interior，且 FAIL', () => {
  const r = verify(makeTask({ skipYs: [18] }));
  assert.ok(kindsOf(r).includes('miss_interior'));
  const f = r.findings.find((x) => x.kind === 'miss_interior');
  // 4m 宽 × 约 40m 长 ≈ 160 m²（允许栅格化 ±10%）
  assert.ok(f.areaM2 > 120 && f.areaM2 < 200, `面积 ${f.areaM2}`);
  assert.ok(f.timeWindow, '内部漏喷应给出邻近时间窗');
  assert.equal(r.conclusion.result, 'FAIL');
  assert.match(r.conclusion.reasons.join(), /未消解/);
});

test('断喷 9 秒：检出 valve_gap 条目，携带阀关时长', () => {
  const r = verify(makeTask({ gapOnY: { y: 22, x0: 16, x1: 34 } }));
  const vg = r.findings.find((f) => f.kind === 'valve_gap');
  assert.ok(vg, `应有断喷条目，实际类型：${kindsOf(r)}`);
  assert.ok(vg.valveGapSec >= 8, `关阀 ${vg.valveGapSec}s`);
  assert.ok(vg.lengthM >= 14, `断喷长度 ${vg.lengthM}m`);
  assert.equal(r.conclusion.result, 'FAIL');
});

test('重飞一行：检出 overlap 且面积合理；overlap 默认不单独判 FAIL（仅重喷）', () => {
  const r = verify(makeTask({ doubleYs: [10] }));
  const ov = r.findings.find((f) => f.kind === 'overlap');
  assert.ok(ov, `应有重喷条目：${kindsOf(r)}`);
  assert.ok(ov.areaM2 > 120 && ov.areaM2 < 200, `重喷面积 ${ov.areaM2}`);
  // 覆盖率不受影响
  assert.ok(r.metrics.coverageRatio > 0.99);
  // 重喷默认严重度 minor、不在 FAIL_DRIVERS → 仍 PASS
  assert.equal(r.conclusion.result, 'PASS');
});

test('最后一行飞出地块 12m：检出 off_field', () => {
  const r = verify(makeTask({ extendLast: 12 }));
  const of = r.findings.filter((f) => f.kind === 'off_field');
  assert.ok(of.length >= 1, `应有界外条目：${kindsOf(r)}`);
  const totalOff = of.reduce((s, f) => s + f.areaM2, 0);
  assert.ok(totalOff > 30, `界外面积 ${totalOff}`);
});

test('禁飞区喷洒：critical 且 FAIL', () => {
  const task = makeTask();
  // 在地块内部登记一个 12m×8m 禁飞区（作业行 y=18/22 会穿过）
  task.noflyZones = [{ name: '测试禁飞区', polygon: [xy([14, 16]), xy([26, 16]), xy([26, 24]), xy([14, 24])] }];
  const r = verify(task);
  const nf = r.findings.find((f) => f.kind === 'nofly');
  assert.ok(nf, `应检出禁飞区喷洒：${kindsOf(r)}`);
  assert.equal(nf.severity, 'critical');
  assert.equal(r.conclusion.result, 'FAIL');
  assert.match(r.conclusion.reasons.join(), /禁飞区/);
});

test('无喷洒字段 → 致命告警，INCONCLUSIVE', () => {
  const task = makeTask();
  task.track.points.forEach((p) => { delete p.spraying; });
  const r = verify(task);
  assert.equal(r.conclusion.result, 'INCONCLUSIVE');
  assert.ok(r.dataWarnings.some((w) => w.code === 'NO_SPRAY_EVENTS' && w.fatal));
});

test('航迹点间隔 16s → GPS_GAP 非致命告警', () => {
  const task = makeTask();
  // 从第 30 个点起整体后移 15 秒：等价于该位置发生一次定位中断（排序后间隔仍在）
  for (let i = 30; i < task.track.points.length; i++) {
    const p = task.track.points[i];
    p.t = new Date(Date.parse(p.t) + 15000).toISOString();
  }
  const r = verify(task);
  const w = r.dataWarnings.find((x) => x.code === 'GPS_GAP');
  assert.ok(w);
  assert.equal(w.fatal, false);
  assert.ok(w.gaps[0].gapSec >= 15);
});

test('时间戳倒流 → TIME_INVERSION 非致命告警', () => {
  const task = makeTask();
  // 交换相邻两点的时间（在原始上传顺序中形成倒流）
  const pts = task.track.points;
  const tmp = pts[10].t; pts[10].t = pts[11].t; pts[11].t = tmp;
  const r = verify(task);
  const w = r.dataWarnings.find((x) => x.code === 'TIME_INVERSION');
  assert.ok(w);
});

test('每条问题都带证据、坐标几何与申诉截止时间', () => {
  const r = verify(makeTask({ skipYs: [18], extendLast: 10 }));
  for (const f of r.findings) {
    assert.match(f.id, /^(MI|ME|VG|OV|OF|NF)-\d{3}$/);
    assert.ok(f.evidence.length >= 1, `${f.id} 无证据`);
    assert.ok(f.geometry?.lngLat?.length >= 2, `${f.id} 无几何`);
    assert.ok(f.location[0] && f.location[1], `${f.id} 无中心坐标`);
    assert.ok(f.appeal.deadline > r.verifiedAt, `${f.id} 无申诉期限`);
  }
});

// ---------- 申诉闭环 ----------
test('申诉状态机：提交→重复被拒→认可后重算→驳回→换理由再申诉', () => {
  const r = verify(makeTask({ skipYs: [18] }));
  const id = r.findings.find((f) => f.kind === 'miss_interior').id;

  // 非法理由
  assert.throws(() => submitAppeal(r, STORE, { findingId: id, reasonCode: 'BOGUS' }), AppealError);
  // OTHER 必须写陈述
  assert.throws(() => submitAppeal(r, STORE, { findingId: id, reasonCode: 'OTHER', statement: '' }), AppealError);

  const a1 = submitAppeal(r, STORE, { findingId: id, reasonCode: 'OBSTACLE', statement: '有树', submitter: '飞手' });
  assert.equal(a1.status, 'open');
  assert.equal(r.conclusion.result, 'FAIL'); // 待受理不改判

  // 重复申诉
  assert.throws(
    () => submitAppeal(r, STORE, { findingId: id, reasonCode: 'OBSTACLE' }),
    (e) => e.code === 'DUPLICATE_APPEAL');

  // 认可 → PASS
  reviewAppeal(r, STORE, { findingId: id, decision: 'approved', comment: '核实有树', reviewer: '监理' });
  assert.equal(r.conclusion.result, 'PASS');
  assert.equal(r.originalConclusion.result, 'FAIL'); // 原始结论封存
  assert.match(r.conclusion.passBasis ?? '', /申诉/);

  // 已认可不能重复申诉
  assert.throws(
    () => submitAppeal(r, STORE, { findingId: id, reasonCode: 'OTHER', statement: 'x' }),
    (e) => e.code === 'DUPLICATE_APPEAL');
});

test('驳回后允许换理由重新申诉', () => {
  const r = verify(makeTask({ skipYs: [18] }));
  const id = r.findings.find((f) => f.kind === 'miss_interior').id;
  submitAppeal(r, STORE, { findingId: id, reasonCode: 'LOG_FAULT', statement: '设备坏了' });
  reviewAppeal(r, STORE, { findingId: id, decision: 'rejected', comment: '证据不足' });
  assert.equal(r.conclusion.result, 'FAIL');
  // 重新申诉，保留历史
  const a2 = submitAppeal(r, STORE, { findingId: id, reasonCode: 'REENTRY', statement: '已补喷' });
  assert.ok(a2.history?.length === 1, '应保留上一轮申诉历史');
  reviewAppeal(r, STORE, { findingId: id, decision: 'approved', comment: '补喷属实' });
  assert.equal(r.conclusion.result, 'PASS');
});

test('撤回：仅待受理可撤回，撤回后可再次申诉', () => {
  const r = verify(makeTask({ skipYs: [18] }));
  const id = r.findings.find((f) => f.kind === 'miss_interior').id;
  submitAppeal(r, STORE, { findingId: id, reasonCode: 'OBSTACLE', statement: 'x' });
  withdrawAppeal(r, STORE, { findingId: id });
  const docket = STORE.load(r.reportId);
  assert.equal(docket.appeals[0].status, 'withdrawn');
  assert.throws(() => withdrawAppeal(r, STORE, { findingId: id }), AppealError);
  // 撤回后可再提
  submitAppeal(r, STORE, { findingId: id, reasonCode: 'OBSTACLE', statement: 'x' });
});

test('篡改报告（改指标/改面积）哈希失配，申诉被拒', async () => {
  const { computeReportHash } = await import('../src/verify.js');
  const r = verify(makeTask({ skipYs: [18] }));
  const id = r.findings[0].id;
  r.metrics.coverageRatio = 1;
  assert.notEqual(computeReportHash(r), r.reportHash);
  assert.throws(
    () => submitAppeal(r, STORE, { findingId: id, reasonCode: 'OTHER', statement: 'x' }),
    (e) => e.code === 'REPORT_TAMPERED');
});

test('申诉认可不改变哈希（证据体封存）', async () => {
  const { computeReportHash } = await import('../src/verify.js');
  const r = verify(makeTask({ skipYs: [18] }));
  const h0 = r.reportHash;
  const id = r.findings.find((f) => f.kind === 'miss_interior').id;
  submitAppeal(r, STORE, { findingId: id, reasonCode: 'OBSTACLE', statement: 'x' });
  reviewAppeal(r, STORE, { findingId: id, decision: 'approved' });
  assert.equal(computeReportHash(r), h0);
});

test('申诉期限：过期提交被拒', () => {
  const r = verify(makeTask({ skipYs: [18] }), { verifiedAt: '2026-09-01T00:00:00Z' });
  const id = r.findings.find((f) => f.kind === 'miss_interior').id;
  assert.throws(
    () => submitAppeal(r, STORE, {
      findingId: id, reasonCode: 'OBSTACLE', statement: 'x',
      submittedAt: '2026-09-20T00:00:00Z',
    }),
    (e) => e.code === 'APPEAL_WINDOW_CLOSED');
  // 第 7 天当天仍可提交
  assert.doesNotThrow(() => submitAppeal(r, STORE, {
    findingId: id, reasonCode: 'OBSTACLE', statement: 'x',
    submittedAt: '2026-09-08T00:00:00Z',
  }));
});

// ---------- 演示任务整体冒烟 ----------
test('演示任务：8 处左右问题，结论 FAIL，六类问题中的主要类都被检出', () => {
  const r = verify(buildMission());
  const kinds = new Set(r.findings.map((f) => f.kind));
  for (const k of ['miss_interior', 'valve_gap', 'overlap', 'off_field', 'nofly']) {
    assert.ok(kinds.has(k), `演示应含 ${k}，实际 ${[...kinds]}`);
  }
  assert.ok(r.dataWarnings.some((w) => w.code === 'GPS_GAP'));
  assert.equal(r.conclusion.result, 'FAIL');
});

test('干净演示任务：PASS', () => {
  const r = verify(buildCleanMission());
  assert.equal(r.conclusion.result, 'PASS');
});

test('阈值可通过 config 覆盖（覆盖率门槛下调到 90%）', () => {
  const r = verify(makeTask({ skipYs: [18], config: { minCoverageRatio: 0.8 } }));
  // 覆盖率 ~96%，但仍有具体漏喷条目 → FAIL_DRIVERS 仍驱动 FAIL（条目证据优先）
  assert.equal(r.conclusion.result, 'FAIL');
  // 若把漏喷面积门槛调高到吞掉该条目不现实，改用界外阈值验证覆盖：
  const r2 = verify(makeTask({ extendLast: 12, config: { maxOffFieldRatio: 0.99, minFindingAreaM2: 500 } }));
  assert.equal(r2.conclusion.result, 'PASS');
});
