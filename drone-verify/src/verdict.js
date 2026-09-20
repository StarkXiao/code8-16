/**
 * verdict.js —— 核验结论分级与问题项（finding）生成。
 *
 * 结论分四级：
 *  - pass              通过：各项指标均在限内
 *  - conditional       部分通过：存在超限项但可补救（如补喷）
 *  - fail              不通过：关键指标严重超限
 *  - insufficient_data 数据不足：缺口面积占比过高，结论不可靠，需补充数据复核
 *
 * 每个 finding 都带证据（GeoJSON 引用、质心、关联航迹时间窗）且可申诉。
 */

export const DEFAULT_THRESHOLDS = {
  passMissRate: 0.01, // 漏喷率 ≤ 1%
  condMissRate: 0.05, // ≤ 5% 可判部分通过（需补喷）
  passRepeatRate: 0.05, // 重喷率 ≤ 5%
  condRepeatRate: 0.1,
  passDosageDev: 0.08, // 亩用量偏差 ≤ 8%
  condDosageDev: 0.15,
  maxUnknownRate: 0.15, // 数据缺口占比 > 15% → 数据不足
};

const SEVERITY_BY_AREA = [
  [10, 'low'],
  [50, 'medium'],
  [Infinity, 'high'],
];

function severityOf(areaM2) {
  return SEVERITY_BY_AREA.find(([limit]) => areaM2 < limit)[1];
}

let findingSeq = 0;
function nextId(prefix) {
  return `F-${prefix}-${++findingSeq}`;
}

/** 供测试重置 id 序列 */
export function _resetFindingSeq() {
  findingSeq = 0;
}

/**
 * 生成问题项列表。
 * @param missedRegions 漏喷连通域（含 areaM2/centroid/hull）
 * @param repeatedRegions 重喷连通域
 * @param extras {dosage, unknownAreaM2, outsideSprayAreaM2, nearestTimeWindow}
 */
export function buildFindings({
  missedRegions,
  repeatedRegions,
  dosage,
  unknownAreaM2,
  outsideSprayAreaM2,
  thresholds,
}) {
  const th = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const findings = [];

  missedRegions.forEach((r, i) => {
    findings.push({
      id: nextId('MISSED'),
      type: 'missed',
      severity: severityOf(r.areaM2),
      areaM2: round1(r.areaM2),
      areaMu: round3(r.areaM2 / 666.6667),
      message: `漏喷区 #${i + 1}：面积 ${round1(r.areaM2)} ㎡，位于 (${r.centroid.map((v) => v.toFixed(1)).join(', ')})`,
      evidence: {
        geojson: `evidence/missed.geojson#/features/${i}`,
        centroidXY: r.centroid,
        hullXY: r.hull,
      },
      status: 'open',
      appealable: true,
    });
  });

  repeatedRegions.forEach((r, i) => {
    findings.push({
      id: nextId('REPEAT'),
      type: 'repeated',
      severity: severityOf(r.areaM2),
      areaM2: round1(r.areaM2),
      areaMu: round3(r.areaM2 / 666.6667),
      message: `重喷区 #${i + 1}：面积 ${round1(r.areaM2)} ㎡，重复覆盖 ≥2 次`,
      evidence: {
        geojson: `evidence/repeated.geojson#/features/${i}`,
        centroidXY: r.centroid,
        hullXY: r.hull,
      },
      status: 'open',
      appealable: true,
    });
  });

  if (dosage && Math.abs(dosage.deviation) > th.passDosageDev) {
    findings.push({
      id: nextId('DOSAGE'),
      type: 'dosage',
      severity: Math.abs(dosage.deviation) > th.condDosageDev ? 'high' : 'medium',
      message:
        `亩用量偏差 ${(dosage.deviation * 100).toFixed(1)}%：` +
        `实际 ${dosage.dosageLPerMu} L/亩 vs 计划 ${dosage.plannedLPerMu} L/亩` +
        `（总流量 ${dosage.totalFlowL} L / 覆盖 ${dosage.coveredMu} 亩）`,
      evidence: { dosage },
      status: 'open',
      appealable: true,
    });
  }

  if (unknownAreaM2 > 0) {
    findings.push({
      id: nextId('GAP'),
      type: 'data_gap',
      severity: 'medium',
      areaM2: round1(unknownAreaM2),
      message:
        `数据缺口区：约 ${round1(unknownAreaM2)} ㎡ 航段缺少航迹或喷洒记录，` +
        `未计入漏喷/重喷判定。可补充数据申诉复核。`,
      evidence: { geojson: 'evidence/unknown.geojson' },
      status: 'open',
      appealable: true,
    });
  }

  if (outsideSprayAreaM2 > 0) {
    findings.push({
      id: nextId('SPILL'),
      type: 'boundary_spill',
      severity: 'low',
      areaM2: round1(outsideSprayAreaM2),
      message: `越界喷洒：地块边界外约 ${round1(outsideSprayAreaM2)} ㎡ 被覆盖（提示项，不影响通过判定）`,
      evidence: {},
      status: 'open',
      appealable: false,
    });
  }

  return findings;
}

/**
 * 综合分级。
 */
export function gradeVerdict(metrics, dosage, thresholds) {
  const th = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const violations = [];
  const conditionals = [];

  if (metrics.unknownRate > th.maxUnknownRate) {
    return {
      level: 'insufficient_data',
      summary:
        `数据缺口面积占比 ${(metrics.unknownRate * 100).toFixed(1)}% 超过 ${th.maxUnknownRate * 100}%，` +
        `核验结论不可靠。请补充完整航迹/喷洒记录后申请复核。`,
      thresholds: th,
    };
  }

  const check = (name, value, passLimit, condLimit, fmt) => {
    if (value <= passLimit) return;
    if (value <= condLimit) conditionals.push(`${name} ${fmt(value)}（限 ${fmt(passLimit)}）`);
    else violations.push(`${name} ${fmt(value)}（限 ${fmt(condLimit)}）`);
  };
  const pct = (v) => `${(v * 100).toFixed(1)}%`;

  check('漏喷率', metrics.missedRate, th.passMissRate, th.condMissRate, pct);
  check('重喷率', metrics.repeatedRate, th.passRepeatRate, th.condRepeatRate, pct);
  if (dosage) check('亩用量偏差', Math.abs(dosage.deviation), th.passDosageDev, th.condDosageDev, pct);

  if (violations.length) {
    return { level: 'fail', summary: `不通过：${violations.join('；')}`, thresholds: th };
  }
  if (conditionals.length) {
    return {
      level: 'conditional',
      summary: `部分通过（需整改/补喷）：${conditionals.join('；')}`,
      thresholds: th,
    };
  }
  return { level: 'pass', summary: '通过：漏喷率、重喷率、亩用量偏差均在限内', thresholds: th };
}

function round1(n) {
  return Math.round(n * 10) / 10;
}
function round3(n) {
  return Math.round(n * 1000) / 1000;
}
