import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gradeVerdict } from '../src/verdict.js';
import { totalFlowLiters, checkDosage } from '../src/dosage.js';

const baseMetrics = {
  missedRate: 0,
  repeatedRate: 0,
  unknownRate: 0,
};
const baseDosage = { deviation: 0 };

test('分级：指标全在限内 → pass', () => {
  const v = gradeVerdict({ ...baseMetrics, missedRate: 0.005 }, baseDosage, {});
  assert.equal(v.level, 'pass');
});

test('分级：漏喷率 1%~5% → conditional（部分通过）', () => {
  const v = gradeVerdict({ ...baseMetrics, missedRate: 0.03 }, baseDosage, {});
  assert.equal(v.level, 'conditional');
});

test('分级：漏喷率超 5% → fail', () => {
  const v = gradeVerdict({ ...baseMetrics, missedRate: 0.2 }, baseDosage, {});
  assert.equal(v.level, 'fail');
});

test('分级：数据缺口超 15% → insufficient_data，其他指标再好也不下结论', () => {
  const v = gradeVerdict({ ...baseMetrics, unknownRate: 0.2 }, baseDosage, {});
  assert.equal(v.level, 'insufficient_data');
});

test('分级：亩用量偏差 8%~15% → conditional', () => {
  const v = gradeVerdict(baseMetrics, { deviation: 0.12 }, {});
  assert.equal(v.level, 'conditional');
});

test('分级：自定义阈值生效', () => {
  const v = gradeVerdict({ ...baseMetrics, missedRate: 0.03 }, baseDosage, {
    passMissRate: 0.05,
  });
  assert.equal(v.level, 'pass');
});

test('流量积分：只累计开喷时段，跨缺口不积分', () => {
  const T0 = 1_000_000;
  const records = [];
  for (let s = 0; s <= 60; s++) records.push({ t: T0 + s * 1000, sprayOn: true, flowLpm: 6 });
  for (let s = 61; s <= 120; s++) records.push({ t: T0 + s * 1000, sprayOn: false, flowLpm: 0 });
  records.push({ t: T0 + 500_000, sprayOn: true, flowLpm: 6 }); // 缺口后的孤立点，不积分
  // 60s × 6L/min = 6L，加上开→关过渡区间的 0.05L
  assert.ok(Math.abs(totalFlowLiters(records) - 6.05) < 1e-9);
});

test('亩用量：总量/覆盖面积，偏差方向正确', () => {
  const T0 = 1_000_000;
  const records = [];
  for (let s = 0; s <= 60; s++) records.push({ t: T0 + s * 1000, sprayOn: true, flowLpm: 10 });
  // 10L / （6666.667㎡ ≈ 10 亩） ≈ 1.0 L/亩，计划 0.8 → 偏差 +25%
  const r = checkDosage(records, 6666.667, 0.8);
  assert.ok(Math.abs(r.dosageLPerMu - 1.0) < 0.01);
  assert.ok(Math.abs(r.deviation - 0.25) < 0.01);
});
