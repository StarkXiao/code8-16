#!/usr/bin/env node
/**
 * cli.js —— 命令行入口。
 *
 * 核验：
 *   node src/cli.js gen-sample --out data/sample
 *   node src/cli.js verify --task task.json --track track.csv --spray spray.csv --out report/
 *   node src/cli.js summary --report report/
 *
 * 申诉与复核：
 *   node src/cli.js appeal  --report report/ --finding F-xxx --by 张三 --reason "..." [--evidence 说明]
 *   node src/cli.js appeals --report report/
 *   node src/cli.js review  --report report/ --appeal AP-0001 --by 核验员
 *   node src/cli.js resolve --report report/ --appeal AP-0001 --decision accepted --by 核验员 [--comment ...]
 *   node src/cli.js reverify --report report/ [--spray 修正记录.csv] [--track 补充航迹.csv] [--by 核验员]
 *     —— 用补充数据重跑核验，生成 report/reverify-vN/；
 *        已受理申诉对应的问题若消失，自动了结申诉并关联新报告。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseTask, parseTrack, parseSpray } from './models.js';
import { runVerification } from './verify.js';
import { writeReport } from './report.js';
import { generateSample } from './sample.js';
import {
  submitAppeal,
  reviewAppeal,
  resolveAppeal,
  settleAppeal,
  listAppeals,
  AppealError,
} from './appeal.js';

const VERDICT_LABEL = {
  pass: '通过',
  conditional: '部分通过（需整改/补喷）',
  fail: '不通过',
  insufficient_data: '数据不足，无法核验',
};

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      args[key] = i + 1 < argv.length && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    } else {
      args._.push(argv[i]);
    }
  }
  return args;
}

function requireOpt(args, name) {
  if (!args[name] || args[name] === true) {
    console.error(`缺少参数 --${name}`);
    process.exit(2);
  }
  return args[name];
}

function loadReport(dir) {
  const file = join(dir, 'report.json');
  if (!existsSync(file)) {
    console.error(`报告不存在：${file}（先运行 verify）`);
    process.exit(2);
  }
  return JSON.parse(readFileSync(file, 'utf8'));
}

function printSummary(report) {
  const m = report.metrics;
  console.log(`\n报告 ${report.reportId}（任务 ${report.taskId}）`);
  console.log(`结论：${VERDICT_LABEL[report.verdict.level] ?? report.verdict.level}`);
  console.log(`  ${report.verdict.summary}`);
  console.log('指标：');
  console.log(`  地块面积      ${m.fieldAreaM2} ㎡（${m.fieldAreaMu} 亩）`);
  console.log(`  有效核验面积  ${m.validAreaM2} ㎡（边界内缩半喷幅，剔除数据缺口）`);
  console.log(`  覆盖率        ${pct(m.coverageRate)}`);
  console.log(`  漏喷          ${m.missedAreaM2} ㎡（${pct(m.missedRate)}）`);
  console.log(`  重喷          ${m.repeatedAreaM2} ㎡（${pct(m.repeatedRate)}）`);
  console.log(`  数据缺口      ${m.unknownAreaM2} ㎡（${pct(m.unknownRate)}）`);
  console.log(`  越界喷洒      ${m.outsideSprayAreaM2} ㎡`);
  console.log(`  亩用量        ${m.dosageLPerMu} L/亩（计划 ${m.plannedLPerMu}，偏差 ${pct(m.deviation)}）`);
  if (report.dataQuality.issues.length) {
    console.log('数据质量提示：');
    for (const i of report.dataQuality.issues) console.log(`  [${i.level}] ${i.message}`);
  }
  console.log(`问题项（${report.findings.length} 条，均可溯源证据，可申诉）：`);
  for (const f of report.findings) {
    const tag = f.appealable ? '' : '（提示项，不可申诉）';
    console.log(`  ${f.id} [${f.severity}] ${f.message}${tag}`);
  }
  console.log('');
}

function pct(v) {
  return `${(v * 100).toFixed(2)}%`;
}

function cmdGenSample(args) {
  const out = requireOpt(args, 'out');
  mkdirSync(out, { recursive: true });
  const s = generateSample();
  writeFileSync(join(out, 'task.json'), s.taskJson);
  writeFileSync(join(out, 'track.csv'), s.trackCsv);
  writeFileSync(join(out, 'spray.csv'), s.sprayCsv);
  writeFileSync(join(out, 'spray-corrected.csv'), s.sprayCorrectedCsv);
  console.log(`样例数据已生成到 ${out}/`);
  console.log('  task.json             作业任务（地块/喷幅/计划亩用量）');
  console.log('  track.csv             航迹（含 RTK 丢点段）');
  console.log('  spray.csv             喷洒记录（含漏喷段）');
  console.log('  spray-corrected.csv   申诉补交的修正喷洒记录（漏喷段实际已开喷）');
}

function cmdVerify(args) {
  const taskPath = requireOpt(args, 'task');
  const trackPath = requireOpt(args, 'track');
  const sprayPath = requireOpt(args, 'spray');
  const out = requireOpt(args, 'out');
  const config = args.config ? JSON.parse(readFileSync(args.config, 'utf8')) : {};

  const task = parseTask(readFileSync(taskPath, 'utf8'));
  const track = parseTrack(readFileSync(trackPath, 'utf8'));
  const spray = parseSpray(readFileSync(sprayPath, 'utf8'));
  const report = runVerification(task, track, spray, config);
  report.input.files = {
    task: resolve(taskPath),
    track: resolve(trackPath),
    spray: resolve(sprayPath),
  };
  mkdirSync(out, { recursive: true });
  const final = writeReport(report, out);
  printSummary(final);
  console.log(`报告与证据已写入 ${out}/（report.json + evidence/*.geojson）`);
}

function cmdAppeal(args) {
  const dir = requireOpt(args, 'report');
  const appeal = submitAppeal(dir, {
    findingId: requireOpt(args, 'finding'),
    appellant: requireOpt(args, 'by'),
    reason: requireOpt(args, 'reason'),
    evidenceNote: args.evidence || '',
  });
  console.log(`申诉已提交：${appeal.id}（针对 ${appeal.findingId}，状态 ${appeal.status}）`);
}

function cmdAppeals(args) {
  const dir = requireOpt(args, 'report');
  const appeals = listAppeals(dir);
  if (!appeals.length) {
    console.log('暂无申诉记录');
    return;
  }
  for (const a of appeals) {
    console.log(`${a.id}  ${a.status}  针对 ${a.findingId}  申诉人 ${a.appellant}`);
    for (const h of a.history) console.log(`    ${h.at}  ${h.action}  by ${h.by}  ${h.comment ?? ''}`);
  }
}

function cmdReview(args) {
  const dir = requireOpt(args, 'report');
  const a = reviewAppeal(dir, requireOpt(args, 'appeal'), { by: requireOpt(args, 'by') });
  console.log(`申诉 ${a.id} 已受理，状态：${a.status}`);
}

function cmdResolve(args) {
  const dir = requireOpt(args, 'report');
  const a = resolveAppeal(dir, requireOpt(args, 'appeal'), {
    decision: requireOpt(args, 'decision'),
    by: requireOpt(args, 'by'),
    comment: args.comment || '',
  });
  console.log(`申诉 ${a.id} 裁定：${a.status}`);
  if (a.status === 'accepted')
    console.log('提示：申诉成立。请用 reverify 补交数据重跑核验，问题消失后申诉自动了结。');
}

function cmdReverify(args) {
  const dir = requireOpt(args, 'report');
  const oldReport = loadReport(dir);
  const files = oldReport.input?.files;
  if (!files) {
    console.error('原报告缺少输入文件路径，无法重核验');
    process.exit(2);
  }
  const trackPath = args.track ? resolve(args.track) : files.track;
  const sprayPath = args.spray ? resolve(args.spray) : files.spray;
  const task = parseTask(readFileSync(files.task, 'utf8'));
  const track = parseTrack(readFileSync(trackPath, 'utf8'));
  const spray = parseSpray(readFileSync(sprayPath, 'utf8'));

  const report = runVerification(task, track, spray, {});
  report.version = (oldReport.version ?? 1) + 1;
  report.supersedes = oldReport.reportId;
  report.input.files = { ...files, track: trackPath, spray: sprayPath };
  const outDir = join(dir, `reverify-v${report.version}`);
  mkdirSync(outDir, { recursive: true });
  const final = writeReport(report, outDir);
  printSummary(final);
  console.log(`复核报告已写入 ${outDir}/`);

  // 已受理申诉：对应问题在新报告中消失 → 自动了结
  const settled = [];
  for (const a of listAppeals(dir).filter((x) => x.status === 'accepted')) {
    const oldFinding = oldReport.findings.find((f) => f.id === a.findingId);
    if (!oldFinding) continue;
    if (findingStillPresent(oldFinding, final.findings)) {
      console.log(`申诉 ${a.id}：问题在新报告中仍存在，保持 accepted，需人工进一步裁定`);
      continue;
    }
    settleAppeal(dir, a.id, {
      by: args.by || 'system',
      comment: `补充数据重核验（${report.reportId}）后问题消失，申诉落实`,
      newReportId: report.reportId,
    });
    settled.push(a.id);
  }
  if (settled.length) console.log(`已自动了结申诉：${settled.join('、')}`);
}

/** 判断旧问题在新报告中是否仍然存在（按类型 + 位置 15m 内匹配） */
function findingStillPresent(oldFinding, newFindings) {
  return newFindings.some((f) => {
    if (f.type !== oldFinding.type) return false;
    const c1 = f.evidence?.centroidXY;
    const c0 = oldFinding.evidence?.centroidXY;
    if (!c1 || !c0) return true; // 无位置信息的类型（如亩用量）按类型存在即未消失
    return Math.hypot(c1[0] - c0[0], c1[1] - c0[1]) < 15;
  });
}

function cmdSummary(args) {
  printSummary(loadReport(requireOpt(args, 'report')));
}

const commands = {
  'gen-sample': cmdGenSample,
  verify: cmdVerify,
  appeal: cmdAppeal,
  appeals: cmdAppeals,
  review: cmdReview,
  resolve: cmdResolve,
  reverify: cmdReverify,
  summary: cmdSummary,
};

const cmd = process.argv[2];
if (!cmd || !commands[cmd]) {
  console.log('无人机植保作业质量核验系统\n');
  console.log('用法：node src/cli.js <命令> [参数]\n');
  console.log('命令：' + Object.keys(commands).join('、'));
  console.log('详见 README.md');
  process.exit(cmd ? 2 : 0);
}
try {
  commands[cmd](parseArgs(process.argv.slice(3)));
} catch (e) {
  if (e instanceof AppealError || e instanceof Error) {
    console.error(`错误：${e.message}`);
    process.exit(1);
  }
  throw e;
}
