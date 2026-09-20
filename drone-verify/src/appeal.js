/**
 * appeal.js —— 申诉与复核。
 *
 * 设计原则：核验结论的每个问题项（finding）都可申诉；
 * 申诉全过程留痕（谁、何时、什么动作、什么理由），
 * 申诉成立后可触发带补充数据的重核验，原报告不篡改，
 * 重核验生成新版本报告并关联申诉单。
 *
 * 状态机：
 *   submitted → under_review → accepted / rejected
 *   accepted  → resolved（重核验完成或人工裁定落实）
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const STORE_FILE = 'appeals.json';

export class AppealError extends Error {}

function loadStore(reportDir) {
  const file = join(reportDir, STORE_FILE);
  if (!existsSync(file)) return { appeals: [] };
  return JSON.parse(readFileSync(file, 'utf8'));
}

function saveStore(reportDir, store) {
  writeFileSync(join(reportDir, STORE_FILE), JSON.stringify(store, null, 2));
}

function loadReport(reportDir) {
  const file = join(reportDir, 'report.json');
  if (!existsSync(file)) throw new AppealError(`报告不存在：${file}`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

function nextAppealId(store) {
  return `AP-${String(store.appeals.length + 1).padStart(4, '0')}`;
}

/**
 * 提交申诉。
 * @param reportDir 报告目录
 * @param {findingId, reason, appellant, evidenceNote} 申诉内容
 */
export function submitAppeal(reportDir, { findingId, reason, appellant, evidenceNote = '' }) {
  if (!reason?.trim()) throw new AppealError('申诉理由不能为空');
  if (!appellant?.trim()) throw new AppealError('申诉人不能为空');
  const report = loadReport(reportDir);
  const finding = report.findings.find((f) => f.id === findingId);
  if (!finding) throw new AppealError(`问题项不存在：${findingId}`);
  if (!finding.appealable) throw new AppealError(`问题项 ${findingId} 不支持申诉`);

  const store = loadStore(reportDir);
  const pending = store.appeals.find(
    (a) => a.findingId === findingId && !['rejected', 'resolved'].includes(a.status)
  );
  if (pending)
    throw new AppealError(`问题项 ${findingId} 已有未结申诉 ${pending.id}，请勿重复提交`);

  const now = new Date().toISOString();
  const appeal = {
    id: nextAppealId(store),
    reportId: report.reportId,
    findingId,
    appellant,
    reason,
    evidenceNote,
    status: 'submitted',
    submittedAt: now,
    history: [{ at: now, action: 'submit', by: appellant, comment: reason }],
  };
  store.appeals.push(appeal);
  saveStore(reportDir, store);
  return appeal;
}

/** 受理申诉（进入复核流程） */
export function reviewAppeal(reportDir, appealId, { by }) {
  return transition(reportDir, appealId, 'under_review', by, '受理申诉');
}

/**
 * 裁定申诉。
 * @param decision 'accepted' | 'rejected'
 * accepted 后应通过 reverify（补充数据重核验）或人工落实，最终进入 resolved。
 */
export function resolveAppeal(reportDir, appealId, { decision, by, comment = '' }) {
  if (!['accepted', 'rejected'].includes(decision))
    throw new AppealError(`非法裁定：${decision}（应为 accepted/rejected）`);
  return transition(reportDir, appealId, decision, by, comment || `裁定：${decision}`);
}

/** 申诉落实（重核验完成 / 人工修正落实）。仅已受理（accepted）的申诉可了结。 */
export function settleAppeal(reportDir, appealId, { by, comment = '', newReportId = null }) {
  const store = loadStore(reportDir);
  const appeal = findAppeal(store, appealId);
  if (appeal.status !== 'accepted')
    throw new AppealError(`申诉 ${appealId} 当前状态 ${appeal.status}，只有 accepted 才能了结`);
  const now = new Date().toISOString();
  appeal.status = 'resolved';
  appeal.resolvedReportId = newReportId;
  appeal.history.push({ at: now, action: 'settle', by, comment, newReportId });
  saveStore(reportDir, store);
  return appeal;
}

function transition(reportDir, appealId, to, by, comment) {
  const store = loadStore(reportDir);
  const appeal = findAppeal(store, appealId);
  const allowed = {
    under_review: ['submitted'],
    accepted: ['submitted', 'under_review'],
    rejected: ['submitted', 'under_review'],
  };
  if (!allowed[to]?.includes(appeal.status))
    throw new AppealError(`申诉 ${appealId} 当前状态 ${appeal.status}，不能转为 ${to}`);
  const now = new Date().toISOString();
  appeal.status = to;
  appeal.history.push({ at: now, action: to, by, comment });
  saveStore(reportDir, store);
  return appeal;
}

function findAppeal(store, appealId) {
  const appeal = store.appeals.find((a) => a.id === appealId);
  if (!appeal) throw new AppealError(`申诉单不存在：${appealId}`);
  return appeal;
}

export function listAppeals(reportDir) {
  return loadStore(reportDir).appeals;
}
