// 自包含 HTML 核验报告：航迹/问题可视化 + 指标 + 可直接导出的单条申诉草稿
import { fmtMu, fmtM2, pct, fmtDateTime, fmtTime } from './util.js';

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

const KIND_COLORS = {
  miss_interior: '#d4380d',
  miss_edge: '#fa8c16',
  valve_gap: '#fa541c',
  overlap: '#722ed1',
  off_field: '#faad14',
  nofly: '#cf1322',
};

const APPEAL_BADGE = {
  none: ['', ''],
  open: ['待受理', '#1677ff'],
  approved: ['申诉已认可', '#52c41a'],
  rejected: ['申诉已驳回', '#8c8c8c'],
  withdrawn: ['申诉已撤回', '#8c8c8c'],
};

export function renderReportHtml(report) {
  const payloadJson = JSON.stringify(report).replace(/</g, '\\u003c');
  const m = report.metrics;
  const c = report.conclusion;
  const oc = report.originalConclusion ?? c;
  const changedByAppeal = oc.result !== c.result;
  const resultColor = c.result === 'PASS' ? '#389e0d' : c.result === 'FAIL' ? '#cf1322' : '#d48806';
  const activeWarnings = report.dataWarnings.filter((w) => !w.fatal);
  const fatalWarnings = report.dataWarnings.filter((w) => w.fatal);

  const rows = report.findings.map((f) => {
    const [badge, bcolor] = APPEAL_BADGE[f.appeal?.status ?? 'none'];
    return `
    <tr data-id="${esc(f.id)}" class="finding-row severity-${esc(f.severity)}">
      <td><code>${esc(f.id)}</code></td>
      <td><span class="dot" style="background:${KIND_COLORS[f.kind]}"></span>${esc(f.title)}</td>
      <td class="num">${f.areaM2 ? fmtM2(f.areaM2) : '—'}</td>
      <td>${f.timeWindow ? `${fmtTime(f.timeWindow.start)}–${fmtTime(f.timeWindow.end)}` : '—'}</td>
      <td>${badge ? `<span class="badge" style="background:${bcolor}">${badge}</span>` : '—'}</td>
      <td><button onclick="locateFinding('${esc(f.id)}')">定位</button>
          <button onclick="exportAppeal('${esc(f.id)}')">申诉</button></td>
    </tr>`;
  }).join('');

  const evidenceBlocks = report.findings.map((f) => `
    <details class="evidence" id="ev-${esc(f.id)}">
      <summary><code>${esc(f.id)}</code> ${esc(f.title)}（申诉截止 ${fmtDateTime(f.appeal?.deadline)}）</summary>
      <ul>${f.evidence.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>
      ${f.samples?.length ? `<div class="samples">证据坐标：
        ${f.samples.map((s) => `<code>${s.lng.toFixed(6)}, ${s.lat.toFixed(6)} @ ${fmtTime(s.t)}</code>`).join(' ')}
      </div>` : ''}
    </details>`).join('');

  const warningBlocks = report.dataWarnings.map((w) => `
    <li class="${w.fatal ? 'fatal' : ''}"><b>${esc(w.detail)}</b>
      ${w.code === 'GPS_GAP' ? `（共 ${w.gapCount} 处，示例：${esc(w.gaps?.[0]?.at.slice(11, 19))} 起间隔 ${w.gaps?.[0]?.gapSec}s）` : ''}
      ${w.code === 'ALTITUDE' ? `（${w.count} 个点偏离标准高度）` : ''}
      ${w.code === 'SPEED' ? `（${w.count} 个点速度越界）` : ''}
    </li>`).join('');

  const appealRows = (report.appeals ?? []).map((a) => `
    <tr>
      <td><code>${esc(a.appealId)}</code></td>
      <td><code>${esc(a.findingId)}</code></td>
      <td>${esc(a.reasonLabel)}</td>
      <td>${esc(a.submitter ?? '—')}</td>
      <td>${fmtDateTime(a.submittedAt)}</td>
      <td><b>${esc(APPEAL_BADGE[a.status]?.[0] ?? a.status)}</b>${a.reviewComment ? `<div class="review">评审意见：${esc(a.reviewComment)}</div>` : ''}</td>
    </tr>`).join('') || '<tr><td colspan="6" class="empty">暂无申诉</td></tr>';

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>核验报告 ${esc(report.reportId)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin:0; font: 14px/1.6 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif; background:#f5f5f5; color:#262626; }
  header { background:#001529; color:#fff; padding:16px 24px; }
  header h1 { margin:0 0 4px; font-size:18px; }
  header .meta { color:#a6b5c5; font-size:12px; }
  main { max-width:1100px; margin:0 auto; padding:20px; }
  .card { background:#fff; border-radius:8px; padding:16px 20px; margin-bottom:16px; box-shadow:0 1px 2px rgba(0,0,0,.06); }
  h2 { font-size:15px; margin:0 0 12px; border-left:4px solid #1677ff; padding-left:8px; }
  .verdict { display:flex; align-items:center; gap:16px; flex-wrap:wrap; }
  .verdict .result { font-size:26px; font-weight:700; color:${resultColor}; }
  .verdict ul { margin:4px 0; padding-left:20px; color:${c.result === 'FAIL' ? '#a8071a' : '#595959'}; }
  .metrics { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; }
  .metric { background:#fafafa; border-radius:6px; padding:10px 12px; }
  .metric .v { font-size:20px; font-weight:600; }
  .metric .k { color:#8c8c8c; font-size:12px; }
  canvas { width:100%; border:1px solid #d9d9d9; border-radius:6px; background:#f0f5ec; cursor:crosshair; }
  .legend { display:flex; gap:14px; flex-wrap:wrap; margin-top:8px; font-size:12px; color:#595959; }
  .legend span { display:inline-flex; align-items:center; gap:4px; }
  .legend i { width:14px; height:4px; border-radius:2px; display:inline-block; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th,td { padding:7px 8px; border-bottom:1px solid #f0f0f0; text-align:left; }
  th { background:#fafafa; color:#595959; font-weight:600; }
  td.num { white-space:nowrap; }
  tr.finding-row { cursor:pointer; }
  tr.finding-row:hover { background:#e6f4ff; }
  .dot { width:8px; height:8px; border-radius:50%; display:inline-block; margin-right:6px; }
  .severity-critical td:first-child { border-left:3px solid #cf1322; }
  .severity-major td:first-child { border-left:3px solid #d4380d; }
  .severity-minor td:first-child { border-left:3px solid #faad14; }
  .badge { color:#fff; border-radius:10px; padding:1px 9px; font-size:12px; white-space:nowrap; }
  button { border:1px solid #1677ff; background:#fff; color:#1677ff; border-radius:4px; padding:2px 10px; cursor:pointer; font-size:12px; margin-right:4px; }
  button:hover { background:#1677ff; color:#fff; }
  .evidence summary { cursor:pointer; padding:6px 0; }
  .evidence ul { margin:6px 0; color:#595959; }
  .samples code, .review { font-size:12px; color:#8c8c8c; }
  .warnings { margin:0; padding-left:18px; }
  .warnings .fatal { color:#cf1322; font-weight:600; }
  .empty { text-align:center; color:#bfbfbf; }
  code { background:#f5f5f5; padding:0 4px; border-radius:3px; font-size:12px; }
  .hash { font-size:11px; color:#8c8c8c; word-break:break-all; }
  .grid2 { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
  @media (max-width:800px){ .grid2 { grid-template-columns:1fr; } }
</style>
</head>
<body>
<header>
  <h1>无人机植保作业质量核验报告 · ${esc(report.mission.name ?? '')}</h1>
  <div class="meta">报告编号 ${esc(report.reportId)} ｜ 核验时间 ${fmtDateTime(report.verifiedAt)} ｜ 飞手 ${esc(report.mission.operatorName ?? '—')} ｜ 组织 ${esc(report.mission.org ?? '—')} ｜ 地块 ${esc(report.field.name ?? '—')}</div>
</header>
<main>
  <div class="card verdict">
    <div class="result">核验结论：${esc(c.label)}</div>
    <div>
      ${changedByAppeal ? `<div style="color:#8c8c8c;font-size:12px">核验当时原始结论：<b>${esc(oc.label)}</b>；经申诉评审后更新为当前结论</div>` : ''}
      ${c.reasons.length ? `<ul>${c.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>`
        : '<div style="color:#595959">覆盖率、界外喷洒等各项指标均满足标准，未发现未消解问题。</div>'}
      ${(report.appeals ?? []).some((a) => a.status === 'approved') ? '<div style="color:#389e0d">注：已认可的申诉条目不纳入不合格判定。</div>' : ''}
    </div>
  </div>

  <div class="card">
    <h2>核心指标</h2>
    <div class="metrics">
      <div class="metric"><div class="v">${pct(m.coverageRatio)}</div><div class="k">地块覆盖率（标准 ≥ ${pct(report.config.minCoverageRatio, 0)}）</div></div>
      <div class="metric"><div class="v">${fmtMu(m.coveredAreaM2)} / ${fmtMu(m.fieldAreaM2)}</div><div class="k">已喷面积 / 地块面积</div></div>
      <div class="metric"><div class="v">${fmtMu(m.missAreaM2)}</div><div class="k">漏喷面积</div></div>
      <div class="metric"><div class="v">${pct(m.overlapRatio)}</div><div class="k">地块内重喷面积占比</div></div>
      <div class="metric"><div class="v">${fmtMu(m.offFieldAreaM2)}</div><div class="k">界外喷洒面积</div></div>
      <div class="metric"><div class="v" style="color:${m.noflyAreaM2 > 0 ? '#cf1322' : 'inherit'}">${fmtMu(m.noflyAreaM2)}</div><div class="k">禁飞区喷洒面积</div></div>
      <div class="metric"><div class="v">${(m.sprayDurationSec / 60).toFixed(1)} 分</div><div class="k">喷洒时长（${m.runCount} 个作业段）</div></div>
      <div class="metric"><div class="v">${m.trackLengthKm} km</div><div class="k">航迹总里程（${m.pointCount} 点）</div></div>
    </div>
  </div>

  ${(fatalWarnings.length || activeWarnings.length) ? `
  <div class="card">
    <h2>数据质量告警</h2>
    <ul class="warnings">${warningBlocks}</ul>
  </div>` : ''}

  <div class="card">
    <h2>航迹与问题分布</h2>
    <canvas id="map" height="560"></canvas>
    <div class="legend">
      <span><i style="background:#52c41a"></i>喷洒中航迹</span>
      <span><i style="background:#bfbfbf"></i>未喷洒航迹/转弯</span>
      <span><i style="background:#d4380d"></i>漏喷（内部）</span>
      <span><i style="background:#fa8c16"></i>漏喷（边缘）</span>
      <span><i style="background:#fa541c"></i>断喷</span>
      <span><i style="background:#722ed1"></i>重喷</span>
      <span><i style="background:#faad14"></i>界外喷洒</span>
      <span><i style="background:#cf1322"></i>禁飞区</span>
    </div>
  </div>

  <div class="card">
    <h2>问题清单（${report.findings.length} 处，可申诉）</h2>
    <table>
      <thead><tr><th>编号</th><th>类型</th><th>面积</th><th>时间窗(UTC)</th><th>申诉状态</th><th>操作</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="6" class="empty">未发现漏喷/重喷/界外喷洒问题</td></tr>'}</tbody>
    </table>
  </div>

  <div class="card">
    <h2>每条问题的核验证据</h2>
    ${evidenceBlocks || '<div class="empty">无问题条目</div>'}
  </div>

  <div class="card">
    <h2>申诉处理记录</h2>
    <table>
      <thead><tr><th>申诉号</th><th>问题</th><th>理由</th><th>申诉人</th><th>提交时间</th><th>状态/评审</th></tr></thead>
      <tbody>${appealRows}</tbody>
    </table>
  </div>

  <div class="card">
    <h2>防篡改与说明</h2>
    <p>本报告正文 SHA-256：</p>
    <p class="hash">${esc(report.reportHash)}</p>
    <p style="color:#8c8c8c;font-size:12px">对报告内容（航迹、指标、问题条目）的任何修改都会使哈希变化，申诉受理时会重新校验。
    申诉须在每条问题标注的截止时间（作业核验后 ${report.config.appealWindowDays} 天）前提交；认可的问题不再纳入不合格判定，驳回的问题维持原结论。</p>
  </div>
</main>
<script>
const REPORT = ${payloadJson};
const COLORS = ${JSON.stringify(KIND_COLORS)};

function drawMap(highlightId) {
  const cv = document.getElementById('map');
  const dpr = window.devicePixelRatio || 1;
  const cssW = cv.clientWidth, cssH = cv.clientHeight || 560;
  cv.width = cssW * dpr; cv.height = cssH * dpr;
  const ctx = cv.getContext('2d'); ctx.scale(dpr, dpr);
  ctx.clearRect(0,0,cssW,cssH);

  const all = [];
  REPORT.field.polygon.outer.forEach(p => all.push(p));
  (REPORT.noflyZones||[]).forEach(z => z.polygon.forEach(p => all.push(p)));
  REPORT.track.points.forEach(p => all.push(p));
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  for (const [x,y] of all){minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);}
  const pad=0.06;
  const w=maxX-minX,h=maxY-minY;
  minX-=w*pad;maxX+=w*pad;minY-=h*pad;maxY+=h*pad;
  const sx=cssW/(maxX-minX), sy=cssH/(maxY-minY), s=Math.min(sx,sy);
  const ox=(cssW-w*(1+2*pad)*s)/2-minX*s, oy=(cssH-h*(1+2*pad)*s)/2+maxY*s;
  const X=lng=>lng*s+ox, Y=lat=>-lat*s+oy;
  const P=p=>[X(p[0]),Y(p[1])];

  // 地块
  ctx.beginPath();
  REPORT.field.polygon.outer.forEach((p,i)=>{const[x,y]=P(p);i?ctx.lineTo(x,y):ctx.moveTo(x,y);});
  ctx.closePath(); ctx.fillStyle='#e6f4d9'; ctx.fill(); ctx.strokeStyle='#7cb305'; ctx.lineWidth=1.5; ctx.stroke();

  // 禁飞区
  for (const z of (REPORT.noflyZones||[])) {
    ctx.beginPath();
    z.polygon.forEach((p,i)=>{const[x,y]=P(p);i?ctx.lineTo(x,y):ctx.moveTo(x,y);});
    ctx.closePath(); ctx.fillStyle='rgba(207,19,34,.18)'; ctx.fill();
    ctx.setLineDash([4,3]); ctx.strokeStyle='#cf1322'; ctx.lineWidth=1.5; ctx.stroke(); ctx.setLineDash([]);
  }

  // 问题区域（先画，航迹叠在上层）
  for (const f of REPORT.findings) {
    if (!f.geometry?.lngLat) continue;
    const hl = highlightId === f.id;
    ctx.beginPath();
    f.geometry.lngLat.forEach((p,i)=>{const[x,y]=P(p);i?ctx.lineTo(x,y):ctx.moveTo(x,y);});
    ctx.closePath();
    ctx.fillStyle = COLORS[f.kind] + (hl ? '66' : '33');
    ctx.fill();
    ctx.strokeStyle = COLORS[f.kind]; ctx.lineWidth = hl ? 2.5 : 1.2;
    if (hl) { ctx.setLineDash([]); } else { ctx.setLineDash([3,3]); }
    ctx.stroke(); ctx.setLineDash([]);
    if (hl) {
      const cx=f.location[0],cy=f.location[1];
      ctx.fillStyle=COLORS[f.kind];
      ctx.font='bold 12px sans-serif';
      ctx.fillText(f.id, X(cx)+6, Y(cy)-6);
    }
  }

  // 航迹
  const pts=REPORT.track.points, sp=REPORT.track.spraying;
  for (let i=1;i<pts.length;i++){
    ctx.beginPath(); ctx.moveTo(X(pts[i-1][0]),Y(pts[i-1][1])); ctx.lineTo(X(pts[i][0]),Y(pts[i][1]));
    ctx.strokeStyle = (sp && sp[i]) ? '#52c41a' : '#bfbfbf';
    ctx.lineWidth = (sp && sp[i]) ? 1.6 : 1;
    ctx.stroke();
  }
  window.__toCanvas = P;
}

function locateFinding(id){
  drawMap(id);
  document.getElementById('ev-'+id)?.open();
  document.getElementById('ev-'+id)?.scrollIntoView({behavior:'smooth',block:'center'});
}

function exportAppeal(id){
  const f = REPORT.findings.find(x=>x.id===id);
  if (!f) return;
  const draft = {
    reportId: REPORT.reportId,
    reportHash: REPORT.reportHash,
    findingId: f.id,
    findingTitle: f.title,
    reasonCode: 'OBSTACLE',
    statement: '请在此填写申诉事实陈述（何时、何因、做了什么处置）',
    evidence: ['例如：现场视频 IMG_0312.mp4、流量计导出 CSV、补喷架次记录 M-20260921-003'],
    submitter: REPORT.mission.operatorName ?? ''
  };
  const blob = new Blob([JSON.stringify(draft,null,2)], {type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'appeal-'+f.id+'.json';
  a.click();
  URL.revokeObjectURL(a.href);
}

document.querySelectorAll('.finding-row').forEach(tr=>{
  tr.addEventListener('click', e=>{ if(e.target.tagName!=='BUTTON') locateFinding(tr.dataset.id); });
});
window.addEventListener('resize', ()=>drawMap());
drawMap();
</script>
</body>
</html>`;
}
