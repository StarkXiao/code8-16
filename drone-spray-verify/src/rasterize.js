// 航迹/喷洒记录栅格化
// 输入：航迹点（含喷洒开关/流量字段或 sprayEvents），输出每个栅格的喷洒覆盖信息
import { Grid } from './grid.js';

/**
 * 判断单个航迹点的喷洒状态。
 * 优先使用显式 sprayEvents（on/off），否则读取点上的 spraying/sprayOn/flow 字段。
 */
export function sprayingAt(index, points, eventsByTime) {
  if (eventsByTime) {
    // eventsByTime: 到该点时间为止"最后一个事件"的状态
    return eventsByTime[index] ?? false;
  }
  const p = points[index];
  if (p.spraying !== undefined) return !!p.spraying;
  if (p.sprayOn !== undefined) return !!p.sprayOn;
  if (p.valve !== undefined) return !!p.valve;
  if (typeof p.flow === 'number') return p.flow > 0;
  if (typeof p.flowLpm === 'number') return p.flowLpm > 0;
  return false;
}

/**
 * 把离散事件 [{at, type:'on'|'off'}] 展开到每个航迹点：
 * 返回 Uint8Array，表示该点时刻是否处于喷洒状态。
 */
export function eventsToPointState(points, events) {
  const state = new Uint8Array(points.length);
  if (!events || events.length === 0) return null;
  const sorted = [...events].sort((a, b) => a.at - b.at);
  let on = false;
  let ei = 0;
  for (let i = 0; i < points.length; i++) {
    const t = points[i].t;
    while (ei < sorted.length && sorted[ei].at <= t) {
      on = sorted[ei].type === 'on';
      ei++;
    }
    state[i] = on ? 1 : 0;
  }
  return state;
}

/**
 * 沿喷洒段在圆盘覆盖栅格上"盖章"。
 * 同一 runId（同一作业行带/架次，可选）多次覆盖只计一次，
 * 不同 runId 重复覆盖则计重喷。
 *
 * @returns {{
 *   runs: Uint16Array|null,          // 每格首次喷洒的 runId+1（0=未喷）
 *   runSetPerCell: Map<number, Set<number>>, // 每格覆盖过的 runId 集合
 * }}
 */
export function stampTrack({ grid, points, sprayState, swath, runOfPoint }) {
  const runs = new Uint16Array(grid.size);
  const runSetPerCell = new Map();
  const radius = swath / 2;

  const stamp = (i) => {
    const p = points[i];
    const runId = runOfPoint ? runOfPoint(i) : 0;
    for (const idx of grid.diskIndices(p.x, p.y, radius, { exact: true })) {
      let set = runSetPerCell.get(idx);
      if (!set) {
        set = new Set();
        runSetPerCell.set(idx, set);
      }
      set.add(runId);
      if (runs[idx] === 0) runs[idx] = runId + 1;
    }
  };

  for (let i = 0; i < points.length; i++) {
    if (sprayState ? sprayState[i] : sprayingAt(i, points, null)) stamp(i);
  }
  return { runs, runSetPerCell };
}

/**
 * 把喷洒轨迹切成"连续段"：off→on 为新段起点，相邻点间隔过大也视为新段。
 * 返回每点的段号（从 1 开始；未喷洒点为 0）。
 */
export function computeRunIds(points, sprayState, maxPointGapSec) {
  const runId = new Uint16Array(points.length);
  let current = 0;
  let prevOn = false;
  for (let i = 0; i < points.length; i++) {
    const on = sprayState ? !!sprayState[i] : sprayingAt(i, points, null);
    if (!on) {
      prevOn = false;
      continue;
    }
    const gap = i > 0 ? points[i].t - points[i - 1].t : 0;
    if (!prevOn || gap > maxPointGapSec) current++;
    runId[i] = current;
    prevOn = true;
  }
  return runId;
}
