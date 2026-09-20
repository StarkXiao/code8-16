/**
 * report.js —— 报告落盘：report.json + GeoJSON 证据文件。
 *
 * 证据文件让结论"可看、可查、可申诉"：
 *  - evidence/missed.geojson    漏喷区（红色多边形）
 *  - evidence/repeated.geojson  重喷区
 *  - evidence/unknown.geojson   数据缺口区
 *  - evidence/track.geojson     航迹（按喷洒状态着色）
 *  - evidence/field.geojson     地块边界
 * 可直接拖入 QGIS / geojson.io 核对。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function writeReport(report, outDir) {
  const { _internal, ...publicReport } = report;
  const { projection, boundaryXY, aligned, coverage } = _internal;
  const evDir = join(outDir, 'evidence');
  mkdirSync(evDir, { recursive: true });

  const toLonLat = ([x, y]) => {
    const [lat, lon] = projection.toLatLon(x, y);
    return [round6(lon), round6(lat)]; // GeoJSON 是 [lon, lat]
  };
  const ringToLonLat = (ring) => ring.map(toLonLat);

  // 地块边界
  writeGeo(join(evDir, 'field.geojson'), [
    {
      type: 'Feature',
      properties: { kind: 'field_boundary', areaM2: publicReport.metrics.fieldAreaM2 },
      geometry: { type: 'Polygon', coordinates: [ringToLonLat([...boundaryXY, boundaryXY[0]])] },
    },
  ]);

  // 漏喷区 / 重喷区
  writeGeo(
    join(evDir, 'missed.geojson'),
    coverage.missedRegions.map((r, i) => regionFeature(r, i, 'missed', toLonLat))
  );
  writeGeo(
    join(evDir, 'repeated.geojson'),
    coverage.repeatedRegions.map((r, i) => regionFeature(r, i, 'repeated', toLonLat))
  );

  // 数据缺口区（unknown 段缓冲带与地块的交集，用航段线表达更直观）
  writeGeo(
    join(evDir, 'unknown.geojson'),
    aligned.segments
      .filter((s) => s.type === 'unknown')
      .map((s, i) => {
        const a = aligned.points[s.a];
        const b = aligned.points[s.b];
        return {
          type: 'Feature',
          properties: {
            kind: 'data_gap',
            index: i,
            timeWindow: [new Date(s.t0).toISOString(), new Date(s.t1).toISOString()],
          },
          geometry: { type: 'LineString', coordinates: [toLonLat([a.x, a.y]), toLonLat([b.x, b.y])] },
        };
      })
  );

  // 航迹（喷洒状态着色）
  writeGeo(
    join(evDir, 'track.geojson'),
    aligned.segments.map((s) => {
      const a = aligned.points[s.a];
      const b = aligned.points[s.b];
      return {
        type: 'Feature',
        properties: {
          kind: 'track_segment',
          spray: s.type, // spray | off | unknown
          t0: new Date(s.t0).toISOString(),
          t1: new Date(s.t1).toISOString(),
        },
        geometry: { type: 'LineString', coordinates: [toLonLat([a.x, a.y]), toLonLat([b.x, b.y])] },
      };
    })
  );

  const evidenceFiles = [
    'evidence/field.geojson',
    'evidence/missed.geojson',
    'evidence/repeated.geojson',
    'evidence/unknown.geojson',
    'evidence/track.geojson',
  ];
  const finalReport = { ...publicReport, evidenceFiles };
  writeFileSync(join(outDir, 'report.json'), JSON.stringify(finalReport, null, 2));
  return finalReport;
}

function regionFeature(region, index, kind, toLonLat) {
  return {
    type: 'Feature',
    properties: {
      kind,
      index,
      areaM2: Math.round(region.areaM2 * 10) / 10,
      areaMu: Math.round((region.areaM2 / 666.6667) * 1000) / 1000,
    },
    geometry: { type: 'Polygon', coordinates: [region.hull.map(toLonLat)] },
  };
}

function writeGeo(file, features) {
  writeFileSync(file, JSON.stringify({ type: 'FeatureCollection', features }, null, 2));
}

function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}
