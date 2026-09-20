/**
 * dosage.js —— 亩用量核验：喷洒记录流量积分 vs 实际覆盖面积。
 */

import { M2_PER_MU } from './geo.js';

/**
 * 对喷洒记录做梯形积分，得到总喷药量（升）。
 * 只累计 spray_on 时段；记录中断处不跨段积分。
 */
export function totalFlowLiters(sprayRecords, maxGapMs = 3000) {
  let liters = 0;
  for (let i = 0; i < sprayRecords.length - 1; i++) {
    const a = sprayRecords[i];
    const b = sprayRecords[i + 1];
    const dtMs = b.t - a.t;
    if (dtMs <= 0 || dtMs > maxGapMs) continue;
    if (!a.sprayOn && !b.sprayOn) continue;
    liters += ((a.flowLpm + b.flowLpm) / 2) * (dtMs / 60000);
  }
  return liters;
}

/**
 * @returns {{totalFlowL, coveredMu, dosageLPerMu, plannedLPerMu, deviation, deviationPct}}
 *   deviation = (实际 - 计划) / 计划；正为超量，负为欠量
 */
export function checkDosage(sprayRecords, coveredAreaM2, plannedLPerMu) {
  const totalFlowL = totalFlowLiters(sprayRecords);
  const mu = coveredAreaM2 / M2_PER_MU;
  const dosageLPerMu = mu > 0 ? totalFlowL / mu : 0;
  const deviation = plannedLPerMu > 0 ? (dosageLPerMu - plannedLPerMu) / plannedLPerMu : 0;
  return {
    totalFlowL: round2(totalFlowL),
    coveredMu: round2(mu),
    dosageLPerMu: round3(dosageLPerMu),
    plannedLPerMu,
    deviation: round3(deviation),
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
function round3(n) {
  return Math.round(n * 1000) / 1000;
}
