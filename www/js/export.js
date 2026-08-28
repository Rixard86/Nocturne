import { S } from './state.js';
import { $, toast } from './ui.js';

/* ---------- export & share (CSV / PDF) ---------- */
function wireExport(){
  const p=$('expPdf'), c=$('expCsv');
  if(p) p.onclick=()=>exportPdf();
  if(c) c.onclick=()=>exportCsv();
}
function fmtDate(d){ return d.toLocaleDateString([], {weekday:'long', year:'numeric', month:'long', day:'numeric'}); }

function buildCsv(n){
  const rows=[];
  rows.push(['Nocturne sleep report']);
  rows.push(['Date', fmtDate(n.date)]);
  rows.push(['Duration (min)', Math.round(n.durationSec/60)]);
  rows.push(['Snore Score', n.score, n.band]);
  rows.push(['Night spent snoring (%)', n.snorePct]);
  rows.push(['Snore events', n.snoreEvents]);
  rows.push(['Breathing pauses', n.pauses]);
  rows.push(['Longest pause (s)', Math.round(n.pauseLongest)]);
  rows.push(['Avg loud level (0-100)', n.avgLvl]);
  rows.push(['Peak level (0-100)', n.peakLvl]);
  rows.push(['Breathing stability (%)', n.stablePct]);
  if(n.stages) rows.push(['Sleep stages (%)', `awake ${n.stages.awake}`, `REM ${n.stages.rem}`, `light ${n.stages.light}`, `deep ${n.stages.deep}`]);
  rows.push(['Sound types', `snoring ${n.snoreEvents}`, `movement ${n.movementCount||0}`, `other ${n.otherCount||0}`]);
  rows.push([]);
  rows.push(['Event #','Type','Start (hh:mm)','Duration (s)','Level (0-100)']);
  n.events.forEach((e,i)=>{
    const hh=Math.floor(e.t/3600), mm=Math.floor((e.t%3600)/60);
    rows.push([i+1, e.kind, `${hh}:${String(mm).padStart(2,'0')}`, (e.dur||0).toFixed(1), e.lvl||0]);
  });
  (n.pauseList||[]).forEach((pz,i)=>{
    const hh=Math.floor(pz.t/3600), mm=Math.floor((pz.t%3600)/60);
    rows.push([`P${i+1}`, 'pause', `${hh}:${String(mm).padStart(2,'0')}`, Math.round(pz.dur), '']);
  });
  // individual movement/other sounds (present for the just-recorded night; stripped on
  // reopen of a past night, where only the summary counts above remain)
  (n.sounds||[]).forEach((sd,i)=>{
    const hh=Math.floor(sd.t/3600), mm=Math.floor((sd.t%3600)/60);
    rows.push([`S${i+1}`, sd.kind, `${hh}:${String(mm).padStart(2,'0')}`, (sd.dur||0).toFixed(1), sd.lvl||0]);
  });
  return rows.map(r=>r.map(cell=>{
    const s=String(cell==null?'':cell);
    return /[",\n]/.test(s)? '"'+s.replace(/"/g,'""')+'"' : s;
  }).join(',')).join('\n');
}

function buildReportHtml(n){
  const esc=s=>String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
  const stageRow = n.stages? `<tr><td>Sleep stages (est.)</td><td>Awake ${n.stages.awake}% · REM ${n.stages.rem}% · Light ${n.stages.light}% · Deep ${n.stages.deep}%</td></tr>`:'';
  const evRows = n.events.slice(0,40).map((e,i)=>{
    const hh=Math.floor(e.t/3600), mm=Math.floor((e.t%3600)/60);
    return `<tr><td>${i+1}</td><td>${esc(e.kind)}</td><td>${hh}:${String(mm).padStart(2,'0')}</td><td>${(e.dur||0).toFixed(1)}s</td><td>${e.lvl||0}</td></tr>`;
  }).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Nocturne report ${esc(fmtDate(n.date))}</title>
  <style>
    body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#111;margin:24px;line-height:1.5}
    h1{margin:0 0 2px;font-size:22px} .sub{color:#666;margin-bottom:18px;font-size:13px}
    .score{font-size:46px;font-weight:700;margin:6px 0} .band{color:#7C5CF0;font-weight:600}
    table{border-collapse:collapse;width:100%;margin:14px 0;font-size:13px}
    td,th{border:1px solid #ddd;padding:7px 9px;text-align:left} th{background:#f4f4f8}
    .grid td:first-child{color:#555;width:55%}
    .note{font-size:11px;color:#777;margin-top:20px;border-top:1px solid #eee;padding-top:10px}
    @media print{ button{display:none} }
    button{background:#7C7CF0;color:#fff;border:0;padding:10px 16px;border-radius:8px;font-size:14px;margin-bottom:16px;cursor:pointer}
  </style></head><body>
  <button onclick="window.print()">Print / Save as PDF</button>
  <h1>Nocturne sleep report</h1>
  <div class="sub">${esc(fmtDate(n.date))} · ${Math.round(n.durationSec/60)} min tracked</div>
  <div class="score">${n.score}<span style="font-size:18px"> / 100</span> <span class="band">${esc(n.band)}</span></div>
  <table class="grid">
    <tr><td>Night spent snoring</td><td>${n.snorePct}%</td></tr>
    <tr><td>Snore events</td><td>${n.snoreEvents}</td></tr>
    <tr><td>Breathing pauses flagged</td><td>${n.pauses}${n.pauses?` (longest ${Math.round(n.pauseLongest)}s)`:''}</td></tr>
    <tr><td>Average loud level</td><td>${n.avgLvl} / 100 (peak ${n.peakLvl})</td></tr>
    <tr><td>Breathing stability</td><td>${n.stablePct}%</td></tr>
    ${stageRow}
    <tr><td>Sound types</td><td>Snoring ${n.snoreEvents} · Movement ${n.movementCount||0} · Other ${n.otherCount||0}</td></tr>
  </table>
  ${n.events.length?`<h3 style="font-size:15px">Detected events</h3>
  <table><tr><th>#</th><th>Type</th><th>Start</th><th>Duration</th><th>Level</th></tr>${evRows}</table>`:''}
  <div class="note"><b>Screening aid, not a medical device.</b> Estimates from a phone microphone; cannot measure airflow or blood oxygen or diagnose sleep apnea. Discuss persistent snoring or witnessed pauses with a physician.</div>
  </body></html>`;
}

async function shareOrDownload(filename, text, mime){
  // Native: write to Filesystem cache + Share sheet. Web: trigger a download.
  const C=window.Capacitor;
  const FS=C&&C.Plugins&&C.Plugins.Filesystem;
  const Sh=C&&C.Plugins&&C.Plugins.Share;
  if(FS && Sh){
    try{
      const res=await FS.writeFile({ path:filename, data:text, directory:'CACHE', encoding:'utf8' });
      await Sh.share({ title:'Nocturne report', url:res.uri });
      return;
    }catch(e){ /* fall through to download */ }
  }
  // web fallback
  const blob=new Blob([text], {type:mime});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a'); a.href=url; a.download=filename; document.body.appendChild(a); a.click();
  a.remove(); setTimeout(()=>URL.revokeObjectURL(url), 1000);
}

function exportCsv(){
  const n=S.current; if(!n){ toast('No report to export'); return; }
  const stamp=n.date.toISOString().slice(0,10);
  shareOrDownload(`nocturne-${stamp}.csv`, buildCsv(n), 'text/csv');
  toast('CSV ready');
}
function exportPdf(){
  const n=S.current; if(!n){ toast('No report to export'); return; }
  const html=buildReportHtml(n);
  const C=window.Capacitor;
  if(C && C.Plugins && C.Plugins.Filesystem && C.Plugins.Share){
    const stamp=n.date.toISOString().slice(0,10);
    shareOrDownload(`nocturne-${stamp}.html`, html, 'text/html');
    toast('Report ready — open it, then Print/Save as PDF');
  } else {
    // web: open a print-ready tab
    const win=window.open('', '_blank');
    if(win){ win.document.write(html); win.document.close(); }
    else toast('Allow pop-ups to export the report');
  }
}

export { wireExport };
