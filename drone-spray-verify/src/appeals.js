// 申诉闭环：提交（校验报告哈希与申诉期限）→ 撤回 → 认可/驳回 → 重算核验结论
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { APPEAL_REASONS, APPEAL_STATUS } from './constants.js';
import { computeReportHash, decideConclusion } from './verify.js';

export class AppealError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** 申诉案卷存储（每个核验报告一个 JSON 文件） */
export class AppealStore {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }

  fileFor(reportId) {
    return path.join(this.dir, `${reportId}.appeals.json`);
  }

  load(reportId) {
    const f = this.fileFor(reportId);
    if (!fs.existsSync(f)) return { reportId, appeals: [] };
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  }

  save(docket) {
    fs.writeFileSync(this.fileFor(docket.reportId), JSON.stringify(docket, null, 2));
  }
}

/** 校验申诉依据的报告没有被篡改 */
export function assertReportIntegrity(report) {
  const expected = computeReportHash(report);
  if (report.reportHash !== expected) {
    throw new AppealError('REPORT_TAMPERED',
      `报告哈希校验失败：当前内容哈希 ${expected.slice(0, 12)}… 与报告记录的 ${String(report.reportHash).slice(0, 12)}… 不一致，` +
      '报告可能已被修改，请使用原始核验报告提交申诉。');
  }
}

function nowIso(at) {
  return at ? new Date(at).toISOString() : new Date().toISOString();
}

/** 提交申诉 */
export function submitAppeal(report, store, {
  findingId, reasonCode, statement = '', evidence = [], submitter, submittedAt,
}) {
  assertReportIntegrity(report);
  const finding = report.findings.find((f) => f.id === findingId);
  if (!finding) throw new AppealError('FINDING_NOT_FOUND', `核验结论中不存在问题条目 ${findingId}`);
  if (!APPEAL_REASONS[reasonCode]) {
    throw new AppealError('BAD_REASON', `不支持的申诉理由：${reasonCode}，可选：${Object.keys(APPEAL_REASONS).join('、')}`);
  }
  if (reasonCode === 'OTHER' && !statement.trim()) {
    throw new AppealError('STATEMENT_REQUIRED', '选择"其他"理由时必须填写具体说明');
  }
  const atIso = nowIso(submittedAt);
  if (finding.appeal?.deadline && new Date(atIso) > new Date(finding.appeal.deadline)) {
    throw new AppealError('APPEAL_WINDOW_CLOSED',
      `申诉期限已于 ${finding.appeal.deadline} 截止，无法对 ${findingId} 提交申诉`);
  }

  const docket = store.load(report.reportId);
  const existing = docket.appeals.find((a) => a.findingId === findingId);
  if (existing && (existing.status === APPEAL_STATUS.OPEN || existing.status === APPEAL_STATUS.APPROVED)) {
    throw new AppealError('DUPLICATE_APPEAL',
      `${findingId} 已存在${existing.status === APPEAL_STATUS.APPROVED ? '被认可的' : '待受理的'}申诉，不能重复提交`);
  }

  const appeal = {
    appealId: `APL-${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
    findingId,
    findingKind: finding.kind,
    reasonCode,
    reasonLabel: APPEAL_REASONS[reasonCode],
    statement,
    evidence,
    submitter: submitter ?? null,
    status: APPEAL_STATUS.OPEN,
    submittedAt: atIso,
    reviewedAt: null,
    reviewer: null,
    reviewComment: null,
  };
  // 被驳回后重新申诉：替换旧记录但保留历史
  if (existing) {
    appeal.history = [{ ...existing }];
    const idx = docket.appeals.findIndex((a) => a.findingId === findingId);
    docket.appeals[idx] = appeal;
  } else {
    docket.appeals.push(appeal);
  }
  store.save(docket);
  applyAppeals(report, docket);
  return appeal;
}

/** 评审：认可 / 驳回 */
export function reviewAppeal(report, store, { findingId, decision, comment = '', reviewer, reviewedAt }) {
  assertReportIntegrity(report);
  if (!['approved', 'rejected'].includes(decision)) {
    throw new AppealError('BAD_DECISION', 'decision 必须是 approved 或 rejected');
  }
  const docket = store.load(report.reportId);
  const appeal = docket.appeals.find((a) => a.findingId === findingId);
  if (!appeal) throw new AppealError('APPEAL_NOT_FOUND', `${findingId} 没有申诉记录`);
  if (appeal.status !== APPEAL_STATUS.OPEN) {
    throw new AppealError('NOT_OPEN', `${findingId} 的申诉状态为 ${appeal.status}，不能评审`);
  }
  appeal.status = decision;
  appeal.reviewedAt = nowIso(reviewedAt);
  appeal.reviewer = reviewer ?? null;
  appeal.reviewComment = comment;
  store.save(docket);
  applyAppeals(report, docket);
  return appeal;
}

/** 撤回待受理申诉 */
export function withdrawAppeal(report, store, { findingId, withdrawnAt }) {
  const docket = store.load(report.reportId);
  const appeal = docket.appeals.find((a) => a.findingId === findingId);
  if (!appeal) throw new AppealError('APPEAL_NOT_FOUND', `${findingId} 没有申诉记录`);
  if (appeal.status !== APPEAL_STATUS.OPEN) {
    throw new AppealError('NOT_OPEN', `只有待受理的申诉可以撤回`);
  }
  appeal.status = APPEAL_STATUS.WITHDRAWN;
  appeal.reviewedAt = nowIso(withdrawnAt);
  store.save(docket);
  applyAppeals(report, docket);
  return appeal;
}

/**
 * 把案卷中的申诉状态同步到报告对象，并重算"申诉后结论"。
 * - originalConclusion：核验当时结论（封存、永不变）
 * - conclusion：当前生效结论（随申诉裁决更新）
 */
export function applyAppeals(report, docket) {
  report.appeals = docket.appeals;
  const byFinding = new Map(docket.appeals.map((a) => [a.findingId, a]));
  for (const f of report.findings) {
    const a = byFinding.get(f.id);
    f.appeal = {
      status: a ? a.status : 'none',
      deadline: f.appeal?.deadline ?? null,
    };
  }
  report.conclusion = decideConclusion(report);
  return report;
}
