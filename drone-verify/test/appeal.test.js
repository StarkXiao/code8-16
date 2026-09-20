import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  submitAppeal,
  reviewAppeal,
  resolveAppeal,
  settleAppeal,
  listAppeals,
  AppealError,
} from '../src/appeal.js';

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'appeal-test-'));
  writeFileSync(
    join(dir, 'report.json'),
    JSON.stringify({
      reportId: 'VR-TEST-1',
      findings: [
        { id: 'F-MISSED-1', type: 'missed', appealable: true },
        { id: 'F-SPILL-2', type: 'boundary_spill', appealable: false },
      ],
    })
  );
});

test('申诉全流程：提交→受理→裁定→了结，全程留痕', () => {
  const a = submitAppeal(dir, {
    findingId: 'F-MISSED-1',
    appellant: '张三',
    reason: '实际已喷，记录缺失',
  });
  assert.equal(a.id, 'AP-0001');
  assert.equal(a.status, 'submitted');

  reviewAppeal(dir, a.id, { by: '李四' });
  resolveAppeal(dir, a.id, { decision: 'accepted', by: '李四', comment: '同意重核验' });
  const settled = settleAppeal(dir, a.id, {
    by: '李四',
    comment: '重核验后问题消失',
    newReportId: 'VR-TEST-2',
  });
  assert.equal(settled.status, 'resolved');
  assert.equal(settled.resolvedReportId, 'VR-TEST-2');

  const actions = settled.history.map((h) => h.action);
  assert.deepEqual(actions, ['submit', 'under_review', 'accepted', 'settle']);
  assert.ok(settled.history.every((h) => h.at && h.by));
});

test('同一问题项存在未结申诉时禁止重复提交', () => {
  submitAppeal(dir, { findingId: 'F-MISSED-1', appellant: '张三', reason: '理由' });
  assert.throws(
    () => submitAppeal(dir, { findingId: 'F-MISSED-1', appellant: '王五', reason: '重复' }),
    AppealError
  );
});

test('提示项不可申诉；不存在的问题项不可申诉', () => {
  assert.throws(
    () => submitAppeal(dir, { findingId: 'F-SPILL-2', appellant: '张三', reason: 'x' }),
    /不支持申诉/
  );
  assert.throws(
    () => submitAppeal(dir, { findingId: 'F-NOPE', appellant: '张三', reason: 'x' }),
    /不存在/
  );
});

test('状态机：未受理的申诉不能了结；非法裁定被拒绝', () => {
  const a = submitAppeal(dir, { findingId: 'F-MISSED-1', appellant: '张三', reason: '理由' });
  assert.throws(() => settleAppeal(dir, a.id, { by: '李四' }), /accepted/);
  assert.throws(
    () => resolveAppeal(dir, a.id, { decision: 'maybe', by: '李四' }),
    /非法裁定/
  );
  resolveAppeal(dir, a.id, { decision: 'rejected', by: '李四' });
  assert.throws(() => settleAppeal(dir, a.id, { by: '李四' }), /accepted/);
});

test('申诉驳回后同一问题项可再次申诉', () => {
  const a1 = submitAppeal(dir, { findingId: 'F-MISSED-1', appellant: '张三', reason: '第一次' });
  resolveAppeal(dir, a1.id, { decision: 'rejected', by: '李四' });
  const a2 = submitAppeal(dir, { findingId: 'F-MISSED-1', appellant: '张三', reason: '补充新证据' });
  assert.equal(a2.id, 'AP-0002');
  assert.equal(listAppeals(dir).length, 2);
});
