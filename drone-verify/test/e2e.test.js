import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '../src/cli.js');

function run(...args) {
  return execFileSync('node', [CLI, ...args], { encoding: 'utf8' });
}

test('端到端：核验 → 申诉 → 补交数据重核验 → 申诉了结', () => {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-'));
  const sampleDir = join(dir, 'sample');
  const reportDir = join(dir, 'report');

  // 1. 生成样例并核验
  run('gen-sample', '--out', sampleDir);
  run(
    'verify',
    '--task', join(sampleDir, 'task.json'),
    '--track', join(sampleDir, 'track.csv'),
    '--spray', join(sampleDir, 'spray.csv'),
    '--out', reportDir
  );
  const report = JSON.parse(readFileSync(join(reportDir, 'report.json'), 'utf8'));

  // 样例场景预期：漏喷 ~308㎡（2.3% 左右）→ 部分通过；重喷 ~252㎡；数据缺口 ~292㎡
  assert.equal(report.verdict.level, 'conditional');
  assert.ok(report.metrics.missedAreaM2 > 250 && report.metrics.missedAreaM2 < 360);
  assert.ok(report.metrics.repeatedAreaM2 > 200 && report.metrics.repeatedAreaM2 < 300);
  assert.ok(report.metrics.unknownAreaM2 > 200);
  assert.ok(report.metrics.outsideSprayAreaM2 > 30);
  assert.ok(Math.abs(report.metrics.deviation) < 0.08);
  const types = report.findings.map((f) => f.type).sort();
  assert.deepEqual(types, ['boundary_spill', 'data_gap', 'missed', 'repeated']);
  // 每个可申诉 finding 都有证据引用与关联航迹时间窗
  const missed = report.findings.find((f) => f.type === 'missed');
  assert.ok(missed.evidence.geojson.startsWith('evidence/missed.geojson'));
  assert.ok(missed.evidence.trackTimeWindow[0] < missed.evidence.trackTimeWindow[1]);
  // 证据文件真实存在
  for (const f of report.evidenceFiles) assert.ok(existsSync(join(reportDir, f)), f);

  // 2. 申诉 → 受理 → 裁定成立
  run('appeal', '--report', reportDir, '--finding', missed.id, '--by', '张三', '--reason', '实际已喷，补交流量计记录');
  run('review', '--report', reportDir, '--appeal', 'AP-0001', '--by', '李四');
  run('resolve', '--report', reportDir, '--appeal', 'AP-0001', '--decision', 'accepted', '--by', '李四');

  // 3. 补交修正喷洒记录重核验
  run('reverify', '--report', reportDir, '--spray', join(sampleDir, 'spray-corrected.csv'), '--by', '李四');
  const v2 = JSON.parse(readFileSync(join(reportDir, 'reverify-v2', 'report.json'), 'utf8'));
  assert.equal(v2.verdict.level, 'pass');
  assert.equal(v2.metrics.missedAreaM2, 0);
  assert.equal(v2.supersedes, report.reportId);

  // 4. 申诉自动了结，历史完整
  const appeals = JSON.parse(readFileSync(join(reportDir, 'appeals.json'), 'utf8')).appeals;
  assert.equal(appeals[0].status, 'resolved');
  assert.equal(appeals[0].resolvedReportId, v2.reportId);
  assert.deepEqual(
    appeals[0].history.map((h) => h.action),
    ['submit', 'under_review', 'accepted', 'settle']
  );
});

test('端到端：对不存在的问题项申诉被拒绝', () => {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-'));
  const sampleDir = join(dir, 'sample');
  const reportDir = join(dir, 'report');
  run('gen-sample', '--out', sampleDir);
  run(
    'verify',
    '--task', join(sampleDir, 'task.json'),
    '--track', join(sampleDir, 'track.csv'),
    '--spray', join(sampleDir, 'spray.csv'),
    '--out', reportDir
  );
  assert.throws(() =>
    run('appeal', '--report', reportDir, '--finding', 'F-NOPE-99', '--by', '张三', '--reason', 'x')
  );
});
