/**
 * verify.js —— 核验主流程编排。
 */

import { createProjection, polygonAreaM2 } from './geo.js';
import { alignTrackWithSpray } from './align.js';
import { analyzeCoverage } from './coverage.js';
import { checkDosage } from './dosage.js';
import { buildFindings, gradeVerdict, DEFAULT_THRESHOLDS } from './verdict.js';

/**
 * 执行一次核验。
 * @param task parseTask 的结果
 * @param track parseTrack 的结果 {points, issues}
 * @param spray parseSpray 的结果 {records, issues}
 * @param config 可选 {thresholds, coverage, align}
 * @returns 完整报告对象（证据几何以平面坐标存于 findings.evidence，
 *          落盘时由 report.js 投影回经纬度）
 */
export function runVerification(task, track, spray, config = {}) {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...task.thresholds, ...config.thresholds };

  // 以地块质心为投影原点
  const n = task.boundary.length;
  const lat0 = task.boundary.reduce((s, p) => s + p[0], 0) / n;
  const lon0 = task.boundary.reduce((s, p) => s + p[1], 0) / n;
  const projection = createProjection(lat0, lon0);
  const boundaryXY = task.boundary.map(([lat, lon]) => projection.toXY(lat, lon));
  const fieldAreaM2 = polygonAreaM2(boundaryXY);

  // 数据质量前置检查：航迹应覆盖作业时段
  const issues = [...track.issues, ...spray.issues];
  const trackStart = track.points[0].t;
  const trackEnd = track.points[track.points.length - 1].t;
  const sprayStart = spray.records[0].t;
  const sprayEnd = spray.records[spray.records.length - 1].t;
  if (sprayEnd < trackStart || sprayStart > trackEnd) {
    issues.push({
      level: 'error',
      message: '喷洒记录与航迹时间范围完全不重叠，请检查两份数据是否属于同一架次',
    });
  }

  const aligned = alignTrackWithSpray(track.points, spray.records, projection, config.align);
  issues.push(...aligned.issues);

  const coverage = analyzeCoverage(task, aligned, boundaryXY, config.coverage);
  // 亩用量分母用"实际喷药面积"（含边界余量带），否则边界内缩会虚增亩用量
  const dosage = checkDosage(spray.records, coverage.metrics.sprayedAreaM2, task.plannedDosageLPerMu);

  const findings = buildFindings({
    missedRegions: coverage.missedRegions,
    repeatedRegions: coverage.repeatedRegions,
    dosage,
    unknownAreaM2: coverage.metrics.unknownAreaM2,
    outsideSprayAreaM2: coverage.metrics.outsideSprayAreaM2,
    thresholds,
  });
  // 为漏喷/重喷 finding 关联最近的航迹时间窗（申诉定位用）
  attachTimeWindows(findings, aligned.points);

  const verdict = gradeVerdict(coverage.metrics, dosage, thresholds);

  const spraySegs = aligned.segments.filter((s) => s.type === 'spray');
  const unknownSegs = aligned.segments.filter((s) => s.type === 'unknown');

  return {
    reportId: `VR-${task.taskId}-${new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14)}`,
    version: 1,
    taskId: task.taskId,
    generatedAt: new Date().toISOString(),
    input: {
      trackPoints: track.points.length,
      sprayRecords: spray.records.length,
      trackTimeRange: [new Date(trackStart).toISOString(), new Date(trackEnd).toISOString()],
      sprayTimeRange: [new Date(sprayStart).toISOString(), new Date(sprayEnd).toISOString()],
    },
    dataQuality: {
      issues,
      spraySegmentCount: spraySegs.length,
      unknownSegmentCount: unknownSegs.length,
    },
    metrics: {
      fieldAreaM2: round1(fieldAreaM2),
      fieldAreaMu: round3(fieldAreaM2 / 666.6667),
      ...mapValues(coverage.metrics, (v) => (v > 1 ? round1(v) : round4(v))),
      ...dosage,
    },
    verdict,
    findings,
    // 供落盘使用的内部数据（不写入 report.json）
    _internal: {
      projection,
      boundaryXY,
      aligned,
      coverage,
    },
  };
}

/** 为漏喷/重喷 finding 找最近航迹点，标注前后 ±5 点的时间窗 */
function attachTimeWindows(findings, points) {
  for (const f of findings) {
    if (!f.evidence?.centroidXY || points.length === 0) continue;
    const [cx, cy] = f.evidence.centroidXY;
    let best = 0;
    let bestD = Infinity;
    points.forEach((p, i) => {
      const d = (p.x - cx) ** 2 + (p.y - cy) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    const lo = points[Math.max(0, best - 5)];
    const hi = points[Math.min(points.length - 1, best + 5)];
    f.evidence.trackTimeWindow = [
      new Date(lo.t).toISOString(),
      new Date(hi.t).toISOString(),
    ];
  }
}

function mapValues(obj, fn) {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, fn(v)]));
}
function round1(n) {
  return Math.round(n * 10) / 10;
}
function round3(n) {
  return Math.round(n * 1000) / 1000;
}
function round4(n) {
  return Math.round(n * 10000) / 10000;
}
