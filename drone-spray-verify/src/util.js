// 通用数值/格式化工具（所有面积单位内部均为平方米，1 亩 = 666.6667 m²）
export const MU_IN_M2 = 2000 / 3;

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function m2ToMu(m2) {
  return m2 / MU_IN_M2;
}

export function fmtMu(m2, digits = 2) {
  return `${m2ToMu(m2).toFixed(digits)} 亩`;
}

export function fmtM2(m2, digits = 0) {
  return `${m2.toFixed(digits)} m²`;
}

export function pct(ratio, digits = 1) {
  if (!Number.isFinite(ratio)) return '—';
  return `${(ratio * 100).toFixed(digits)}%`;
}

export function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(11, 19);
}

export function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

export function round(v, digits = 2) {
  const k = 10 ** digits;
  return Math.round(v * k) / k;
}

export function addDays(iso, days) {
  return new Date(new Date(iso).getTime() + days * 86400_000).toISOString();
}
