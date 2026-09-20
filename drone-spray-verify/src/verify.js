// 核验编排：任务输入 -> 核验报告（含指标、问题清单、数据告警、结论、防篡改哈希）
import crypto from 'node:crypto';
import {
  centroidLngLat, makeProjector, polygonArea, pointInPolygon, haversineKm, distanceToRing,
} from './geo.js';
import { Grid } from './grid.js';
import { eventsToPointState, stampTrack, computeRunIds, sprayingAt } from './rasterize.js';
import { detectFindings } from './findings.js';
import {
  DEFAULT_CONFIG, FAIL_DRIVERS, DATA_WARNINGS, SCHEMA_VERSION,
} from './constants.js';
import { addDays, round } from './util.js';

function toEpochSec(t) {
  if (typeof t === 'number') return t > 1e12 ? t / 1000 : t;
  const ms = Date.parse(t);
  if (Number.isNaN(ms)) throw new Error(`无法解析时间: ${t}`);
  return ms / 1000;
}

function normalizeRing(ring) {
  if (!Array.isArray(ring) || ring.length < 3) {
    throw new Error('多边形至少需要 3 个顶点');
  }
  // 容忍首尾重复
  const first = ring[0], last = ring[ring.length - 1];
  if (first[0] === last[0] && first[1] === last[1]) return ring.slice(0, -1);
  return ring.map(([lng, lat]) => [lng, lat]);
}

/** 解析并校验任务输入 */
export function parseMission(input) {
  if (!input || typeof input !== 'object') throw new Error('任务输入为空');
  const mission = input.mission ?? {};
  const field = input.field;
  if (!field || !field.polygon || !field.polygon.outer) {
    throw new Error('缺少 field.polygon.outer（地块边界）');
  }
  const spray = input.spray ?? {};
  if (typeof spray.swath !== 'number' || spray.swath <= 0) {
    throw new Error('缺少 spray.swath（喷幅，米）');
  }
  const config = { ...DEFAULT_CONFIG, ...(input.config ?? {}) };
  if (config.nominalAltitudeM === undefined && spray.nominalAltitudeM) {
    config.nominalAltitudeM = spray.nominalAltitudeM;
  }
  const outer = normalizeRing(field.polygon.outer);
  const holes = (field.polygon.holes ?? []).map(normalizeRing);
  const noflyZones = (input.noflyZones ?? []).map((z) => ({
    name: z.name ?? '未命名禁飞区',
    ring: normalizeRing(z.polygon ?? z.ring),
  }));
  const rawPoints = input.track?.points ?? [];
  const points = rawPoints.map((p) => ({
    t: toEpochSec(p.t ?? p.time ?? p.timestamp),
    lng: p.lng ?? p.lon ?? p.longitude,
    lat: p.lat ?? p.latitude,
    alt: p.alt ?? p.altitude ?? p.height ?? null,
    speed: p.speed ?? p.velocity ?? null,
    spraying: p.spraying ?? p.sprayOn ?? p.valve ?? (typeof p.flow === 'number' ? p.flow > 0 : undefined),
  }));
  // 在排序前按上传顺序检测时间倒流（定位设备异常的信号）
  let timeInversions = 0;
  for (let i = 1; i < points.length; i++) if (points[i].t < points[i - 1].t) timeInversions++;
  points.sort((a, b) => a.t - b.t);
  const sprayEvents = (input.track?.sprayEvents ?? []).map((e) => ({
    at: toEpochSec(e.at ?? e.time ?? e.t),
    type: e.type === 'on' || e.type === 'open' ? 'on' : 'off',
  })).sort((a, b) => a.at - b.at);

  return { mission, field: { ...field, outer, holes }, noflyZones, spray, points, sprayEvents, config, timeInversions };
}

/** 数据质量告警 */
function collectDataWarnings(m) {
  const warnings = [];
  const { points, sprayEvents, config } = m;
  if (points.length === 0) {
    return [{ code: 'NO_POINTS', fatal: true, detail: DATA_WARNINGS.NO_POINTS }];
  }
  let hasSpraySignal = sprayEvents.length > 0;
  if (!hasSpraySignal) {
    hasSpraySignal = points.some((p) => p.spraying !== undefined);
  }
  if (!hasSpraySignal) {
    warnings.push({ code: 'NO_SPRAY_EVENTS', fatal: true, detail: DATA_WARNINGS.NO_SPRAY_EVENTS });
  }
  // points 已按时间排序；时间倒流计数在解析阶段（原始顺序）得到
  if (m.timeInversions > 0) {
    warnings.push({ code: 'TIME_INVERSION', fatal: false, detail: DATA_WARNINGS.TIME_INVERSION, count: m.timeInversions });
  }

  const gaps = [];
  for (let i = 1; i < points.length; i++) {
    const gap = points[i].t - points[i - 1].t;
    if (gap > config.maxPointGapSec) {
      gaps.push({
        at: new Date(points[i - 1].t * 1000).toISOString(),
        gapSec: round(gap, 1),
        from: [points[i - 1].lng, points[i - 1].lat],
        to: [points[i].lng, points[i].lat],
      });
    }
  }
  if (gaps.length) warnings.push({ code: 'GPS_GAP', fatal: false, detail: DATA_WARNINGS.GPS_GAP, gaps: gaps.slice(0, 10), gapCount: gaps.length });

  const altBad = [];
  const nominal = config.nominalAltitudeM;
  if (nominal > 0) {
    for (const p of points) {
      if (p.alt == null) continue;
      if (Math.abs(p.alt - nominal) / nominal > config.altitudeTolerance) {
        altBad.push({ t: new Date(p.t * 1000).toISOString(), alt: p.alt });
      }
    }
    if (altBad.length) {
      warnings.push({ code: 'ALTITUDE', fatal: false, detail: DATA_WARNINGS.ALTITUDE,
        count: altBad.length, samples: altBad.slice(0, 5) });
    }
  }
  const speedBad = [];
  const [vMin, vMax] = config.speedRange;
  for (const p of points) {
    if (p.speed == null) continue;
    if (p.speed < vMin || p.speed > vMax) speedBad.push({ t: new Date(p.t * 1000).toISOString(), speed: p.speed });
  }
  if (speedBad.length) {
    warnings.push({ code: 'SPEED', fatal: false, detail: DATA_WARNINGS.SPEED,
      count: speedBad.length, samples: speedBad.slice(0, 5) });
  }
  return warnings;
}

/** 递归按键名排序，使哈希不受对象键序列化顺序影响 */
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (key === 'appeal') continue; // 申诉状态不属于封存的证据体
      out[key] = canonicalize(value[key]);
    }
    return out;
  }
  return value;
}

/**
 * 核验证据体的规范化哈希：只封存"核验结论所依据的原始证据"
 * （航迹、指标、问题条目、数据告警、结论）。申诉记录与每条问题的申诉状态
 * 是裁决流程的增量数据，允许附加到报告而不破坏封存；
 * 任何人改动证据体都会使哈希失配。
 */
export function computeReportHash(report) {
  const sealed = {
    schemaVersion: report.schemaVersion,
    reportId: report.reportId,
    verifiedAt: report.verifiedAt,
    mission: report.mission,
    field: report.field,
    noflyZones: report.noflyZones,
    spray: report.spray,
    config: report.config,
    metrics: report.metrics,
    counts: report.counts,
    findings: report.findings,
    dataWarnings: report.dataWarnings,
    track: report.track,
    // 封存的是"作业核验当时"的结论；申诉裁决只会更新可变的 report.conclusion
    originalConclusion: report.originalConclusion,
  };
  return crypto.createHash('sha256')
    .update(JSON.stringify(canonicalize(sealed)))
    .digest('hex');
}

/**
 * 依据指标、问题与申诉状态给出结论（申诉认可后可重算）。
 * 指标阈值（覆盖率、界外占比）是问题面积的汇总，为避免重复计罚：
 * 被认可的漏喷/界外条目面积从缺口/界外面积中豁免后再比阈值。
 */
export function decideConclusion(report) {
  const w = report.dataWarnings.filter((x) => x.fatal);
  if (w.length) {
    return {
      result: 'INCONCLUSIVE',
      label: '无法判定',
      reasons: w.map((x) => x.detail),
    };
  }
  const m = report.metrics;
  const c = report.config;
  const approved = new Set(
    (report.appeals ?? []).filter((a) => a.status === 'approved').map((a) => a.findingId));

  const findings = report.findings;
  const activeFindings = findings.filter((f) => !approved.has(f.id));

  // 豁免面积：被认可的漏喷类问题面积从漏喷面积中扣除；被认可的界外面积从界外面积中扣除
  let exemptedMissM2 = 0, exemptedOffFieldM2 = 0, exemptedNoflyM2 = 0;
  for (const f of findings) {
    if (!approved.has(f.id)) continue;
    if (f.kind === 'miss_interior' || f.kind === 'miss_edge' || f.kind === 'valve_gap') {
      exemptedMissM2 += f.areaM2 ?? 0;
    } else if (f.kind === 'off_field') {
      exemptedOffFieldM2 += f.areaM2 ?? 0;
    } else if (f.kind === 'nofly') {
      exemptedNoflyM2 += f.areaM2 ?? 0;
    }
  }

  const reasons = [];
  const notes = [];
  if (exemptedMissM2 > 0 || exemptedOffFieldM2 > 0 || exemptedNoflyM2 > 0) {
    const parts = [];
    if (exemptedMissM2) parts.push(`漏喷 ${exemptedMissM2.toFixed(0)} m²`);
    if (exemptedOffFieldM2) parts.push(`界外 ${exemptedOffFieldM2.toFixed(0)} m²`);
    if (exemptedNoflyM2) parts.push(`禁飞区 ${exemptedNoflyM2.toFixed(0)} m²`);
    notes.push(`经申诉认可，豁免：${parts.join('、')}`);
  }

  // 1) 禁飞区：有未消解的禁飞区条目即不合格（合规红线，指标兜底）
  if (activeFindings.some((f) => f.kind === 'nofly') || m.noflyAreaM2 - exemptedNoflyM2 > 1) {
    reasons.push('存在禁飞区喷洒记录（禁飞区属合规红线）');
  }

  // 2) 覆盖率：扣除豁免缺口后的有效覆盖率
  const effectiveMissM2 = Math.max(0, m.missAreaM2 - exemptedMissM2);
  const effectiveCoverage = 1 - effectiveMissM2 / m.fieldAreaM2;
  if (effectiveCoverage < c.minCoverageRatio) {
    reasons.push(`有效覆盖率 ${(effectiveCoverage * 100).toFixed(1)}% 低于标准 ${(c.minCoverageRatio * 100).toFixed(0)}%（仍有 ${effectiveMissM2.toFixed(0)} m² 未消解缺口）`);
  }

  // 3) 界外：扣除豁免面积
  const effectiveOffField = Math.max(0, m.offFieldAreaM2 - exemptedOffFieldM2);
  const sprayedFieldPlusOff = m.fieldAreaM2 + effectiveOffField;
  if (effectiveOffField / Math.max(1, sprayedFieldPlusOff) > c.maxOffFieldRatio
      && activeFindings.some((f) => f.kind === 'off_field')) {
    reasons.push(`界外喷洒 ${effectiveOffField.toFixed(0)} m²，仍存在未消解的界外条目`);
  }

  // 4) 未消解的漏喷类条目（面积条目即直接证据，比阈值更明确）
  const activeMiss = activeFindings
    .filter((f) => FAIL_DRIVERS.has(f.kind) && f.kind !== 'nofly')
    .map((f) => f.id);
  if (activeMiss.length) {
    reasons.push(`存在 ${activeMiss.length} 处未消解的漏喷类问题：${activeMiss.join('、')}`);
  }

  const result = reasons.length ? 'FAIL' : 'PASS';
  return {
    result,
    label: result === 'PASS' ? '合格' : '不合格',
    reasons,
    ...(notes.length ? { notes } : {}),
    ...(result === 'PASS' && notes.length ? {
      passBasis: '原始核验为不合格；全部不合格驱动项均已通过申诉评审认可，缺口面积按豁免处理，改判合格。',
    } : {}),
  };
}

/** 主入口：执行核验，返回完整报告对象 */
export function verify(input, opts = {}) {
  const m = parseMission(input);
  const verifiedAt = (opts.verifiedAt ? new Date(opts.verifiedAt).toISOString() : new Date().toISOString());

  // 投影
  const [lng0, lat0] = centroidLngLat(m.field.outer);
  const proj = makeProjector(lng0, lat0);
  const outerXY = m.field.outer.map(proj.project);
  const holesXY = m.field.holes.map((h) => h.map(proj.project));
  const noflyXY = m.noflyZones.map((z) => ({ name: z.name, ring: z.ring.map(proj.project) }));
  const points = m.points.map((p) => ({
    ...p,
    x: proj.project([p.lng, p.lat])[0],
    y: proj.project([p.lng, p.lat])[1],
  }));

  // 栅格范围：地块 + 全部航迹点，外扩一个喷幅
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of outerXY) {
    minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
    minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
  }
  for (const p of points) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  const swath = m.spray.swath;
  const cell = swath / m.config.cellDivisor;
  const grid = Grid.fromBbox([minX, minY, maxX, maxY], swath, cell);

  // 地块 / 禁飞区栅格
  const fieldCells = new Set();
  for (let iy = 0; iy < grid.ny; iy++) {
    for (let ix = 0; ix < grid.nx; ix++) {
      const c = grid.center(grid.index(ix, iy));
      if (pointInPolygon(c, outerXY, holesXY)) fieldCells.add(grid.index(ix, iy));
    }
  }
  const noflyCells = new Set();
  const noflyHitsByZone = noflyXY.map(() => 0);
  for (let iy = 0; iy < grid.ny; iy++) {
    for (let ix = 0; ix < grid.nx; ix++) {
      const idx = grid.index(ix, iy);
      const c = grid.center(idx);
      for (let z = 0; z < noflyXY.length; z++) {
        if (pointInPolygon(c, noflyXY[z].ring)) {
          noflyCells.add(idx);
          noflyHitsByZone[z]++;
          break;
        }
      }
    }
  }

  // 喷洒状态与作业行带
  let sprayState = eventsToPointState(points, m.sprayEvents);
  if (!sprayState) {
    const hasField = points.some((p) => p.spraying !== undefined);
    if (hasField) {
      sprayState = new Uint8Array(points.length);
      for (let i = 0; i < points.length; i++) sprayState[i] = sprayingAt(i, points, null) ? 1 : 0;
    }
  }
  const runIdsArr = sprayState ? computeRunIds(points, sprayState, m.config.maxPointGapSec) : new Uint16Array(points.length);
  const { runSetPerCell } = stampTrack({
    grid, points, sprayState, swath,
    runOfPoint: (i) => runIdsArr[i],
  });
  const sprayedCells = new Set(runSetPerCell.keys());

  // 边界搭接豁免：贴地块边界、界外深度 <= 半个喷幅的喷幅圆盘外溢是全覆盖作业的
  // 必然结果（端点喷到界桩时圆盘必然越过边界），不计为界外喷洒问题。
  // 真正的界外作业（成片、有纵深、远离边界）不受影响。
  const boundaryLapCells = new Set();
  for (const idx of sprayedCells) {
    if (fieldCells.has(idx) || noflyCells.has(idx)) continue;
    const c = grid.center(idx);
    if (distanceToRing(c, outerXY) <= swath / 2 + grid.cell / 2) {
      boundaryLapCells.add(idx);
    }
  }

  const offFieldCells = new Set();
  for (const idx of sprayedCells) {
    if (!fieldCells.has(idx) && !boundaryLapCells.has(idx)) offFieldCells.add(idx);
  }

  // 问题识别
  const detected = detectFindings({
    grid, project: proj.unproject, points, sprayState, swath,
    outer: outerXY, holes: holesXY, noflyZones: noflyXY,
    fieldCells, sprayedCells, noflyCells, offFieldCells, boundaryLapCells,
    runSetPerCell, runIds: runIdsArr,
    config: m.config,
  });
  const appealDeadline = addDays(verifiedAt, m.config.appealWindowDays);
  const findings = detected.findings.map((f) => ({
    ...f,
    appeal: { status: 'none', deadline: appealDeadline },
  }));

  // 指标
  const cellArea = cell * cell;
  const fieldAreaM2 = polygonArea(outerXY, holesXY);
  let coveredInField = 0, overlapInField = 0;
  for (const idx of fieldCells) {
    if (sprayedCells.has(idx)) coveredInField++;
    if ((runSetPerCell.get(idx)?.size ?? 0) >= 2) overlapInField++;
  }
  const coveredAreaM2 = coveredInField * cellArea;
  const missAreaM2 = Math.max(0, fieldAreaM2 - coveredAreaM2);
  const totalSprayedAreaM2 = sprayedCells.size * cellArea;
  // 界外喷洒指标同样豁免边界搭接带；禁飞区喷洒单独统计（红线，不豁免）
  const offFieldSprayed = [...sprayedCells]
    .filter((i) => !fieldCells.has(i) && !boundaryLapCells.has(i) && !noflyCells.has(i)).length;
  const noflySprayed = [...sprayedCells].filter((i) => noflyCells.has(i)).length;
  const boundaryLapAreaM2 = boundaryLapCells.size * cellArea;
  const offFieldAreaM2 = offFieldSprayed * cellArea;
  const noflyAreaM2 = noflySprayed * cellArea;

  let sprayStart = null, sprayEnd = null, trackLengthKm = 0;
  for (let i = 0; i < points.length; i++) {
    if (sprayState?.[i]) {
      if (sprayStart === null) sprayStart = points[i].t;
      sprayEnd = points[i].t;
    }
    if (i > 0) trackLengthKm += haversineKm([points[i - 1].lng, points[i - 1].lat], [points[i].lng, points[i].lat]);
  }

  const counts = { critical: 0, major: 0, minor: 0 };
  for (const f of findings) counts[f.severity]++;

  const metrics = {
    fieldAreaM2: round(fieldAreaM2, 1),
    fieldAreaMu: round(fieldAreaM2 / (2000 / 3), 2),
    coveredAreaM2: round(coveredAreaM2, 1),
    missAreaM2: round(missAreaM2, 1),
    coverageRatio: round(coveredAreaM2 / fieldAreaM2, 4),
    overlapAreaM2: round(overlapInField * cellArea, 1),
    overlapRatio: round(overlapInField / Math.max(1, coveredInField), 4),
    offFieldAreaM2: round(offFieldAreaM2, 1),
    noflyAreaM2: round(noflyAreaM2, 1),
    boundaryLapM2: round(boundaryLapAreaM2, 1),
    totalSprayedAreaM2: round(totalSprayedAreaM2, 1),
    offFieldRatio: round(offFieldSprayed / Math.max(1, sprayedCells.size), 4),
    sprayDurationSec: sprayStart !== null ? round(sprayEnd - sprayStart, 1) : 0,
    trackLengthKm: round(trackLengthKm, 3),
    pointCount: points.length,
    runCount: runIdsArr.length ? Math.max(...runIdsArr) : 0,
    cellSizeM: round(cell, 3),
  };

  const dataWarnings = collectDataWarnings(m);

  const report = {
    schemaVersion: SCHEMA_VERSION,
    reportId: input.reportId ?? `RPT-${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
    verifiedAt,
    mission: {
      id: m.mission.id ?? null,
      name: m.mission.name ?? null,
      operator: m.mission.operator ?? null,
      operatorName: m.mission.operatorName ?? null,
      org: m.mission.org ?? null,
    },
    field: {
      name: m.field.name ?? null,
      location: input.field?.location ?? null,
      polygon: { outer: m.field.outer, holes: m.field.holes },
    },
    noflyZones: m.noflyZones.map((z) => ({ name: z.name, polygon: z.ring })),
    spray: m.spray,
    config: m.config,
    metrics,
    counts,
    findings,
    dataWarnings,
    track: {
      // 前端画图只需要投影坐标，这里保留经纬度点（大数据量时调用方可裁剪）
      points: points.map((p) => [p.lng, p.lat]),
      spraying: sprayState ? [...sprayState] : null,
    },
    appeals: [],
    reportHash: null,
  };

  const conclusion = decideConclusion(report);
  report.originalConclusion = conclusion;
  report.conclusion = conclusion;
  report.reportHash = computeReportHash(report);
  return report;
}
