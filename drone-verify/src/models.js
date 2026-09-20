/**
 * models.js —— 输入数据的解析与校验。
 *
 * 三类输入：
 *  - 作业任务 task.json：地块边界、计划喷幅、计划亩用量、（可选）核验阈值
 *  - 航迹 track.csv：ts,lat,lon[,alt_m,speed_mps]，至少 1Hz
 *  - 喷洒记录 spray.csv：ts,spray_on,flow_lpm
 *
 * 校验分两级：致命问题直接抛错（数据无法使用）；
 * 非致命问题记入 issues，随报告输出（数据质量是申诉的重要依据）。
 */

/**
 * @typedef {Object} Task
 * @property {string} taskId
 * @property {number[][]} boundary 地块边界 [[lat,lon],...]
 * @property {number} swathWidthM 计划喷幅（米）
 * @property {number} plannedDosageLPerMu 计划亩用量（升/亩）
 * @property {number} [plannedSpeedMps] 计划航速
 * @property {Object} [thresholds] 覆盖默认核验阈值
 */

export function parseTask(json) {
  const t = typeof json === 'string' ? JSON.parse(json) : json;
  const errors = [];
  if (!t.taskId) errors.push('缺少 taskId');
  if (!Array.isArray(t.boundary) || t.boundary.length < 3)
    errors.push('boundary 至少需要 3 个顶点');
  if (!(t.swathWidthM > 0)) errors.push('swathWidthM 必须为正数');
  if (!(t.plannedDosageLPerMu > 0)) errors.push('plannedDosageLPerMu 必须为正数');
  if (errors.length) throw new Error(`任务文件无效：${errors.join('；')}`);
  return {
    taskId: String(t.taskId),
    boundary: t.boundary.map(([lat, lon]) => {
      if (Math.abs(lat) > 90 || Math.abs(lon) > 180)
        throw new Error(`地块顶点坐标越界：[${lat}, ${lon}]`);
      return [lat, lon];
    }),
    swathWidthM: t.swathWidthM,
    plannedDosageLPerMu: t.plannedDosageLPerMu,
    plannedSpeedMps: t.plannedSpeedMps ?? null,
    thresholds: t.thresholds ?? {},
  };
}

/** 解析时间戳：支持 epoch 毫秒/秒、ISO 8601 字符串 */
export function parseTimestamp(v) {
  if (typeof v === 'number' || /^\d+(\.\d+)?$/.test(String(v).trim())) {
    const n = Number(v);
    return n < 1e12 ? n * 1000 : n; // 秒级时间戳转毫秒
  }
  const ms = Date.parse(v);
  if (Number.isNaN(ms)) throw new Error(`无法解析时间戳：${v}`);
  return ms;
}

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const header = lines[0].split(',').map((h) => h.trim());
  return lines.slice(1).filter((l) => l.trim()).map((line) => {
    const cols = line.split(',');
    const row = {};
    header.forEach((h, i) => (row[h] = cols[i]?.trim()));
    return row;
  });
}

/**
 * 解析航迹 CSV → [{t, lat, lon, alt, speed}]
 * speed 缺失时返回 null，由调用方差分估算。
 */
export function parseTrack(csvText) {
  const rows = parseCsv(csvText);
  if (rows.length < 2) throw new Error('航迹点不足（<2），无法核验');
  const issues = [];
  const points = rows.map((r, i) => {
    const lat = Number(r.lat);
    const lon = Number(r.lon);
    if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180))
      throw new Error(`第 ${i + 2} 行坐标无效：lat=${r.lat}, lon=${r.lon}`);
    return {
      t: parseTimestamp(r.ts),
      lat,
      lon,
      alt: r.alt_m !== undefined && r.alt_m !== '' ? Number(r.alt_m) : null,
      speed: r.speed_mps !== undefined && r.speed_mps !== '' ? Number(r.speed_mps) : null,
    };
  });
  // 时间戳乱序：排序并记录（飞控导出偶发乱序，属于可修复数据问题）
  let unordered = 0;
  for (let i = 1; i < points.length; i++) {
    if (points[i].t < points[i - 1].t) unordered++;
  }
  if (unordered > 0) {
    points.sort((a, b) => a.t - b.t);
    issues.push({ level: 'warn', message: `航迹存在 ${unordered} 处时间戳乱序，已按时间重排` });
  }
  // 去重（完全同一时间戳）
  const deduped = points.filter((p, i) => i === 0 || p.t !== points[i - 1].t);
  if (deduped.length !== points.length)
    issues.push({ level: 'warn', message: `剔除 ${points.length - deduped.length} 个重复时间戳航迹点` });
  return { points: deduped, issues };
}

/**
 * 解析喷洒记录 CSV → [{t, sprayOn, flowLpm}]
 */
export function parseSpray(csvText) {
  const rows = parseCsv(csvText);
  if (rows.length < 2) throw new Error('喷洒记录不足（<2），无法核验');
  const issues = [];
  const records = rows.map((r, i) => {
    const on = String(r.spray_on).toLowerCase();
    if (!['0', '1', 'true', 'false'].includes(on))
      throw new Error(`第 ${i + 2} 行 spray_on 无效：${r.spray_on}（应为 0/1）`);
    const flow = Number(r.flow_lpm);
    if (!(flow >= 0))
      throw new Error(`第 ${i + 2} 行 flow_lpm 无效：${r.flow_lpm}`);
    return {
      t: parseTimestamp(r.ts),
      sprayOn: on === '1' || on === 'true',
      flowLpm: flow,
    };
  });
  let unordered = 0;
  for (let i = 1; i < records.length; i++) {
    if (records[i].t < records[i - 1].t) unordered++;
  }
  if (unordered > 0) {
    records.sort((a, b) => a.t - b.t);
    issues.push({ level: 'warn', message: `喷洒记录存在 ${unordered} 处时间戳乱序，已按时间重排` });
  }
  return { records, issues };
}
