// 演示数据：一块 100m × 80m 地块上的仿米字形作业航迹，注入多种典型作业问题
import { M_PER_DEG_LAT } from './geo.js';

const ORIGIN = [113.25, 23.1]; // 广东某农田

function mToLngLat(x, y) {
  const [lng0, lat0] = ORIGIN;
  const mPerDegLng = M_PER_DEG_LAT * Math.cos(lat0 * Math.PI / 180);
  return [lng0 + x / mPerDegLng, lat0 + y / M_PER_DEG_LAT];
}

const FIELD_W = 100;
const FIELD_H = 80;
const SWATH = 4;
const SPACING = 4;
const STEP = 2; // 航迹点间距（米）
const ALT = 2.5;

function rectPolygon(x0, y0, x1, y1) {
  return [
    mToLngLat(x0, y0),
    mToLngLat(x1, y0),
    mToLngLat(x1, y1),
    mToLngLat(x0, y1),
  ];
}

/**
 * 生成演示任务输入。
 * anomalies 可关闭单项：{ skipLine, valveGap, doublePass, offField, nofly, gpsGap }
 */
export function buildMission(anomalies = {}) {
  const a = {
    skipLine: true, valveGap: true, doublePass: true,
    offField: true, nofly: true, gpsGap: true,
    ...anomalies,
  };

  // 作业行（米坐标），蛇形往返
  const lineYs = [];
  for (let y = SPACING / 2; y < FIELD_H; y += SPACING) lineYs.push(y);
  const SKIP_Y = 30; // 整行漏喷
  const GAP_Y = 54; // 中途断喷
  const DOUBLE_Y = 14; // 整行重飞
  const GAP_X0 = 40, GAP_X1 = 58; // 断喷区间
  const OFFFIELD_LEN = 12;

  const runs = [];
  lineYs.forEach((y, li) => {
    if (a.skipLine && y === SKIP_Y) return;
    const ltr = li % 2 === 0;
    let x0 = ltr ? 0 : FIELD_W;
    let x1 = ltr ? FIELD_W : 0;
    if (a.offField && y === lineYs[lineYs.length - 1] && !ltr) {
      x1 = -OFFFIELD_LEN; // 最末行右→左，多飞出地西界
    }
    runs.push({ x0, x1, y, spraying: true, kind: 'line' });
    // 重飞紧跟在 y=14 那行之后，随后 15 秒定位中断再接下一行
    if (a.doublePass && y === DOUBLE_Y) {
      runs.push({ x0: 0, x1: FIELD_W, y: DOUBLE_Y, spraying: true, kind: 'repass' });
    }
  });

  // 采样成航迹点（含行与行之间的转弯点，转弯不喷）
  const points = [];
  const events = [];
  let t = Date.UTC(2026, 8, 20, 2, 0, 0) / 1000;
  let cursor = null;

  const moveTo = (x, y, spraying) => {
    if (!cursor) {
      cursor = { x, y };
      points.push(mkPoint(x, y, t, false));
      return;
    }
    const d = Math.hypot(x - cursor.x, y - cursor.y);
    const steps = Math.max(1, Math.round(d / STEP));
    for (let s = 1; s <= steps; s++) {
      const xx = cursor.x + (x - cursor.x) * (s / steps);
      const yy = cursor.y + (y - cursor.y) * (s / steps);
      t += 1; // 2 米/秒
      points.push(mkPoint(xx, yy, t, false));
    }
    cursor = { x, y };
  };

  function mkPoint(x, y, ts, spraying) {
    const [lng, lat] = mToLngLat(x, y);
    return {
      t: new Date(ts * 1000).toISOString(),
      lng: Number(lng.toFixed(9)), lat: Number(lat.toFixed(9)),
      alt: ALT, speed: 2,
      spraying: !!spraying, // 转弯点显式 false，避免被"无喷洒字段"的兼容逻辑误判为在喷
    };
  }

  for (const run of runs) {
    // 飞到起点（转弯段，不喷）
    moveTo(run.x0, run.y, false);
    const dir = run.x1 >= run.x0 ? 1 : -1;
    const n = Math.round(Math.abs(run.x1 - run.x0) / STEP);
    for (let s = 0; s <= n; s++) {
      const x = run.x0 + dir * s * STEP;
      t += 1;
      let on = run.spraying;
      if (a.valveGap && run.y === GAP_Y && x > GAP_X0 && x < GAP_X1) on = false;
      const pt = mkPoint(x, run.y, t, on);
      pt.spraying = on;
      // gps 中断：在重飞航段结束后制造一个 16 秒的点间隔（仅警告）
      points.push(pt);
      cursor = { x, y: run.y };
    }
    if (a.gpsGap && run.kind === 'repass') t += 15;
  }

  const noflyZones = a.nofly
    ? [{ name: '村内 10kV 高压走廊（登记禁飞区）', polygon: rectPolygon(74, 36, 86, 46) }]
    : [];

  return {
    reportId: 'RPT-DEMO20260920',
    mission: {
      id: 'M-20260920-017',
      name: '晚稻统防统治 · 3 号田',
      operator: 'U-10086',
      operatorName: '陈伟（飞手）',
      org: '广州市增城区惠农植保合作社',
    },
    field: {
      name: '3 号田（村东）',
      location: '广东省广州市增城区',
      polygon: { outer: rectPolygon(0, 0, FIELD_W, FIELD_H) },
    },
    noflyZones,
    spray: {
      swath: SWATH,
      chemical: '氯虫苯甲酰胺 200g/L SC',
      nominalDoseMlPerMu: 10,
      nominalAltitudeM: ALT,
    },
    track: {
      droneModel: 'P-100 植保无人机',
      points,
      sprayEvents: events,
    },
    config: {},
  };
}

/** 一份"几乎完美"的作业（用于对照合格结论） */
export function buildCleanMission() {
  return buildMission({
    skipLine: false, valveGap: false, doublePass: false,
    offField: false, nofly: false, gpsGap: false,
  });
}
