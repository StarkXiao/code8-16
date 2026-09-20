#!/usr/bin/env node
// 命令行：demo 生成样例 / verify 核验 / appeal 提交申诉 / review 评审 / withdraw 撤回
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { verify } from './verify.js';
import { buildMission } from './demo.js';
import { renderReportHtml } from './report-html.js';
import { AppealStore, submitAppeal, reviewAppeal, withdrawAppeal, AppealError } from './appeals.js';
import { fmtMu, fmtM2, pct, fmtDateTime } from './util.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

function usage() {
  console.log(`无人机植保作业质量核验系统 (dsv)

用法:
  dsv demo [--out DIR] [--name N]
      生成演示任务（含典型漏喷/断喷/重喷/界外/禁飞区/定位中断）

  dsv verify --input MISSION.json [--out DIR] [--set key=value ...]
      执行核验，输出报告 JSON + 自包含 HTML
      --set 可覆盖阈值，例如 --set minCoverageRatio=0.95 --set appealWindowDays=15

  dsv appeal --report REPORT.json --payload APPEAL.json [--appeals-dir DIR]
      提交申诉（payload 含 findingId/reasonCode/statement/evidence/submitter）
      可改用单独参数：--finding MI-001 --reason OBSTACLE --statement "..." --submitter "陈伟"

  dsv review --report REPORT.json --finding MI-001 --decision approved \
      --comment "现场视频属实" --reviewer "监理:李明" [--appeals-dir DIR]
      评审申诉（approved|rejected），自动重算结论并重写报告 JSON/HTML

  dsv withdraw --report REPORT.json --finding MI-001 [--appeals-dir DIR]
      撤回待受理申诉

退出码: 0=合格  2=不合格  3=无法判定  1=运行错误
`);
}

function parseArgs(argv) {
  const args = { _: [], set: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) { args[key] = true; }
      else { args[key] = next; i++; }
    } else args._.push(a);
  }
  return args;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

function applyConfigOverrides(input, setArgs) {
  if (!setArgs.length) return input;
  const config = { ...(input.config ?? {}) };
  for (const kv of setArgs) {
    const [k, v] = kv.split('=');
    if (!k || v === undefined) throw new Error(`--set 参数格式错误: ${kv}（应为 key=value）`);
    let val = v;
    if (v === 'true') val = true;
    else if (v === 'false') val = false;
    else if (v !== '' && !Number.isNaN(Number(v))) val = Number(v);
    config[k.trim()] = val;
  }
  return { ...input, config };
}

function printSummary(report) {
  const c = report.conclusion;
  const m = report.metrics;
  console.log('');
  console.log('──────────────────────────────────────────────────────');
  console.log(`报告编号 : ${report.reportId}`);
  console.log(`任务     : ${report.mission.name ?? '—'}（${report.mission.operatorName ?? '—'}）`);
  console.log(`核验时间 : ${fmtDateTime(report.verifiedAt)}`);
  console.log('──────────────────────────────────────────────────────');
  console.log(`地块面积 ${fmtMu(m.fieldAreaM2)} ｜ 已喷 ${fmtMu(m.coveredAreaM2)} ｜ 覆盖率 ${pct(m.coverageRatio)}`);
  console.log(`漏喷 ${fmtMu(m.missAreaM2)} ｜ 重喷 ${fmtM2(m.overlapAreaM2)}（${pct(m.overlapRatio)}）｜ 界外 ${fmtMu(m.offFieldAreaM2)} ｜ 禁飞区 ${fmtMu(m.noflyAreaM2)}`);
  console.log(`喷洒 ${(m.sprayDurationSec / 60).toFixed(1)} 分钟 / ${m.runCount} 段 ｜ 航迹 ${m.trackLengthKm} km ｜ ${m.pointCount} 个定位点`);
  if (report.dataWarnings.length) {
    console.log(`数据告警 : ${report.dataWarnings.length} 条（${report.dataWarnings.filter((w) => w.fatal).length} 条致命）`);
    for (const w of report.dataWarnings) {
      console.log(`   ${w.fatal ? '✗' : '⚠'} ${w.detail}`);
    }
  }
  console.log('');
  if (report.findings.length) {
    console.log(`问题清单（${report.findings.length} 处，申诉截止 ${fmtDateTime(report.findings[0].appeal.deadline)}）:`);
    for (const f of report.findings) {
      const appeal = f.appeal?.status && f.appeal.status !== 'none'
        ? `  [申诉:${{ open: '待受理', approved: '已认可', rejected: '已驳回', withdrawn: '已撤回' }[f.appeal.status]}]` : '';
      const size = f.areaM2 ? fmtM2(f.areaM2) : '';
      const tw = f.timeWindow ? ` ${f.timeWindow.start.slice(11, 19)}–${f.timeWindow.end.slice(11, 19)}` : '';
      console.log(`  ${f.id}  ${f.title}  ${size}${tw}${appeal}`);
    }
  } else {
    console.log('问题清单 : 无');
  }
  console.log('');
  console.log(`>>> 核验结论：【${c.label}】`);
  for (const r of c.reasons) console.log(`    - ${r}`);
  console.log('');
}

function outputPaths(outDir, reportId) {
  return {
    json: path.join(outDir, `${reportId}.json`),
    html: path.join(outDir, `${reportId}.html`),
  };
}

function writeOutputs(report, outDir) {
  const p = outputPaths(outDir, report.reportId);
  writeJson(p.json, report);
  fs.writeFileSync(p.html, renderReportHtml(report));
  return p;
}

function loadReport(file) {
  const report = readJson(file);
  if (!report.reportId || !report.metrics) throw new Error('该文件不像核验报告（缺少 reportId/metrics）');
  return report;
}

function getAppealsDir(args, reportFile) {
  return args['appeals-dir']
    ? path.resolve(args['appeals-dir'])
    : path.join(path.dirname(path.resolve(reportFile)), 'appeals');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (!cmd || args.help || args.h) { usage(); process.exit(cmd ? 0 : 1); }

  try {
    if (cmd === 'demo') {
      const outDir = path.resolve(args.out ?? path.join(ROOT, 'out', 'demo'));
      const mission = buildMission();
      const file = path.join(outDir, 'mission.demo.json');
      writeJson(file, mission);
      console.log(`演示任务已生成: ${file}`);
      console.log('运行核验: dsv verify --input "' + file + '"');
      return 0;
    }

    if (cmd === 'verify') {
      if (!args.input) throw new Error('缺少 --input MISSION.json');
      const outDir = path.resolve(args.out ?? path.join(ROOT, 'out', 'reports'));
      let input = readJson(path.resolve(args.input));
      input = applyConfigOverrides(input, args.set ?? []);
      const report = verify(input);
      const p = writeOutputs(report, outDir);
      printSummary(report);
      console.log(`报告 JSON: ${p.json}`);
      console.log(`可视化报告: ${p.html}`);
      console.log(`报告哈希: ${report.reportHash}`);
      return report.conclusion.result === 'PASS' ? 0
        : report.conclusion.result === 'FAIL' ? 2 : 3;
    }

    if (cmd === 'appeal') {
      if (!args.report) throw new Error('缺少 --report REPORT.json');
      const reportFile = path.resolve(args.report);
      const report = loadReport(reportFile);
      let payload = {};
      if (args.payload) payload = readJson(path.resolve(args.payload));
      if (args.finding) payload.findingId = args.finding;
      if (args.reason) payload.reasonCode = args.reason;
      if (args.statement) payload.statement = args.statement;
      if (args.submitter) payload.submitter = args.submitter;
      if (!payload.findingId || !payload.reasonCode) {
        throw new Error('申诉必须包含 findingId 与 reasonCode（用 --payload 文件或 --finding/--reason 参数）');
      }
      const store = new AppealStore(getAppealsDir(args, reportFile));
      const appeal = submitAppeal(report, store, payload);
      const p = writeOutputs(report, path.dirname(reportFile));
      console.log(`申诉已提交: ${appeal.appealId}（问题 ${appeal.findingId}，理由：${appeal.reasonLabel}）`);
      console.log(`当前结论：【${report.conclusion.label}】（受理评审后结论可能更新）`);
      console.log(`报告已更新: ${p.html}`);
      return 0;
    }

    if (cmd === 'review' || cmd === 'withdraw') {
      if (!args.report) throw new Error('缺少 --report REPORT.json');
      if (!args.finding) throw new Error('缺少 --finding <问题编号>');
      const reportFile = path.resolve(args.report);
      const report = loadReport(reportFile);
      const store = new AppealStore(getAppealsDir(args, reportFile));
      if (cmd === 'review') {
        if (!args.decision) throw new Error('缺少 --decision approved|rejected');
        reviewAppeal(report, store, {
          findingId: args.finding,
          decision: args.decision,
          comment: args.comment ?? '',
          reviewer: args.reviewer ?? null,
        });
        console.log(`已${args.decision === 'approved' ? '认可' : '驳回'} ${args.finding} 的申诉`);
      } else {
        withdrawAppeal(report, store, { findingId: args.finding });
        console.log(`已撤回 ${args.finding} 的申诉`);
      }
      writeOutputs(report, path.dirname(reportFile));
      printSummary(report);
      return report.conclusion.result === 'PASS' ? 0
        : report.conclusion.result === 'FAIL' ? 2 : 3;
    }

    usage();
    throw new Error(`未知命令: ${cmd}`);
  } catch (err) {
    if (err instanceof AppealError) {
      console.error(`申诉被拒绝 [${err.code}]: ${err.message}`);
    } else {
      console.error(`错误: ${err.message}`);
    }
    process.exit(1);
  }
}

process.exitCode = main();
