/**
 * align.js —— 航迹与喷洒记录的时间对齐，并切分出航迹段。
 *
 * 航迹点与喷洒记录通常来自两个独立日志（飞控 vs 药箱流量计），
 * 时间戳不同步是常态。对齐策略：
 *  - 开关状态取最近邻（离散量不插值），容差 alignToleranceMs；
 *  - 流量取前后记录线性插值（连续量）；
 *  - 超出容差或记录范围外的点标记 sprayOn=null（未知）。
 *
 * 相邻航迹点切分为段，类型：
 *  - 'spray'   两点均确认喷洒中
 *  - 'off'     其余确认未喷洒的情况
 *  - 'unknown' 航迹缺口（dt 超 maxTrackGapMs）或喷洒状态未知
 * unknown 段不计入覆盖、也不计为漏喷 —— 它是"数据缺口"，
 * 是申诉补正数据的主要对象。
 */

export const DEFAULT_ALIGN = {
  alignToleranceMs: 1500, // 喷洒记录匹配容差
  maxTrackGapMs: 3000, // 航迹相邻点最大间隔，超过视为缺口
  maxReasonableSpeedMps: 20, // 超过视为 GPS 漂移点
};

export function alignTrackWithSpray(trackPoints, sprayRecords, projection, opts = {}) {
  const cfg = { ...DEFAULT_ALIGN, ...opts };
  const issues = [];

  // 投影到平面坐标，并按需差分估算速度
  const pts = trackPoints.map((p) => {
    const [x, y] = projection.toXY(p.lat, p.lon);
    return { ...p, x, y };
  });
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].speed == null) {
      const dt = (pts[i].t - pts[i - 1].t) / 1000;
      if (dt > 0 && dt * 1000 <= cfg.maxTrackGapMs) {
        pts[i].derivedSpeed = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y) / dt;
      }
    }
  }
  const speedOf = (p) => p.speed ?? p.derivedSpeed ?? null;

  // 漂移点检测（不剔除，只记录——剔除会制造人为缺口）
  let driftCount = 0;
  for (const p of pts) {
    const v = speedOf(p);
    if (v != null && v > cfg.maxReasonableSpeedMps) driftCount++;
  }
  if (driftCount > 0)
    issues.push({ level: 'warn', message: `发现 ${driftCount} 个疑似 GPS 漂移点（速度 > ${cfg.maxReasonableSpeedMps} m/s）` });

  // 时间对齐
  let si = 0;
  let alignFail = 0;
  const aligned = pts.map((p) => {
    while (si < sprayRecords.length - 1 && sprayRecords[si + 1].t <= p.t) si++;
    let ni = si;
    if (si + 1 < sprayRecords.length && Math.abs(sprayRecords[si + 1].t - p.t) < Math.abs(sprayRecords[si].t - p.t))
      ni = si + 1;
    const nearest = sprayRecords[ni];
    if (!nearest || Math.abs(nearest.t - p.t) > cfg.alignToleranceMs) {
      alignFail++;
      return { ...p, sprayOn: null, flowLpm: null };
    }
    // 流量线性插值
    const next = sprayRecords[ni + 1];
    let flow = nearest.flowLpm;
    if (next && next.t > nearest.t) {
      const k = (p.t - nearest.t) / (next.t - nearest.t);
      flow = nearest.flowLpm + (next.flowLpm - nearest.flowLpm) * Math.max(0, Math.min(1, k));
    }
    return { ...p, sprayOn: nearest.sprayOn, flowLpm: flow };
  });
  if (alignFail > 0)
    issues.push({
      level: 'warn',
      message: `${alignFail}/${pts.length} 个航迹点未能对齐喷洒记录（容差 ${cfg.alignToleranceMs}ms），相关航段按"数据缺口"处理`,
    });

  // 切段
  const segments = [];
  for (let i = 0; i < aligned.length - 1; i++) {
    const a = aligned[i];
    const b = aligned[i + 1];
    const dt = b.t - a.t;
    let type;
    if (dt > cfg.maxTrackGapMs) type = 'unknown';
    else if (a.sprayOn == null || b.sprayOn == null) type = 'unknown';
    else if (a.sprayOn && b.sprayOn) type = 'spray';
    else type = 'off';
    segments.push({
      a: i,
      b: i + 1,
      t0: a.t,
      t1: b.t,
      type,
      avgFlowLpm: type === 'spray' ? ((a.flowLpm ?? 0) + (b.flowLpm ?? 0)) / 2 : 0,
      avgSpeedMps: dt > 0 ? Math.hypot(b.x - a.x, b.y - a.y) / (dt / 1000) : 0,
    });
  }
  return { points: aligned, segments, issues };
}
