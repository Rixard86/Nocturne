import { drawHypnogram, drawTimelineReport } from './charts.js';
import { wireExport } from './export.js';
import { switchView } from './navigation.js';
import { loadPlayer, startPlayback, stopPlayback, wirePlayer } from './player.js';
import { S } from './state.js';
import { $, band, fmtMin } from './ui.js';

/* ============================================================
   REPORT RENDER
   ============================================================ */
// Reopen a saved night: make it the current report and show it. Past nights carry a
// persisted mini-timeline + hypnogram so the charts still render (raw samples are gone).
// Make a night the report's subject without navigating to it. Used on launch so the
// Report tab holds last night instead of an empty state — previously that only happened
// as a side effect of re-finalizing the night on every start, which also duplicated it.
function loadNightIntoReport(night){
  S.current=night;
  // reset the player/selection state for the reopened night
  S._curEv=null; S._selT=null; S._playlist=null;
  if(typeof stopPlayback==='function') stopPlayback();
  renderReport();
}

function openNight(night){
  loadNightIntoReport(night);
  switchView('report');
  requestAnimationFrame(()=>{ if($('tl'))drawTimelineReport(); if($('hypno'))drawHypnogram(); });
}
function renderReport(){
  const n=S.current;
  if(!n){ $('reportBody').innerHTML=emptyState('No night analyzed yet','Record a night or load a sample to see your report.'); return; }
  const b=band(n.score);
  const ahiNote = n.pauses>0
    ? `${n.pauses} pause-pattern${n.pauses>1?'s':''} flagged (longest ${Math.round(n.pauseLongest)}s)`
    : 'No pause patterns flagged';

  $('reportBody').innerHTML=`
    <div class="score-card">
      <div class="sc-label">Snore Score${n.isDemo?' · sample':''}</div>
      <div class="sc-row">
        <div class="sc-num">${n.score}</div>
        <div class="sc-band" style="color:${b.col};background:${b.bg}">${b.name}</div>
      </div>
      <div class="sc-date">${n.date.toLocaleDateString([],{weekday:'short',month:'short',day:'numeric'})} · ${fmtMin(n.durationSec)} tracked</div>
      <div class="sc-bar"><div style="width:${n.score}%"></div></div>
    </div>

    <div class="grid2">
      <div class="mcard">
        <div class="mv">${n.snorePct}<small>%</small></div>
        <div class="ml">Night spent snoring</div>
        <div class="mnote">${n.snoreEvents} distinct snore events</div>
      </div>
      <div class="mcard ${n.pauses>0?'alert':''}">
        <div class="mv">${n.pauses}</div>
        <div class="ml">Breathing pauses</div>
        <div class="mnote">${ahiNote}</div>
      </div>
      <div class="mcard">
        <div class="mv">${n.avgLvl}<small></small></div>
        <div class="ml">Avg loud level</div>
        <div class="mnote">Peak ${n.peakLvl} · relative scale 0–100</div>
      </div>
      <div class="mcard">
        <div class="mv">${n.stablePct}<small>%</small></div>
        <div class="ml">Breathing stability</div>
        <div class="mnote">Time in steady rhythm</div>
      </div>
    </div>

    <div class="sec-title"><span class="bar"></span>The night, hour by hour</div>
    <div class="timeline">
      <canvas id="tl"></canvas>
      <div class="tl-axis" id="tlAxis"></div>
      <div class="tl-legend">
        <div class="lg"><i style="background:linear-gradient(90deg,var(--sig-a),var(--sig-b))"></i>Sound intensity</div>
        <div class="lg"><i style="background:var(--flag)"></i>Pause-pattern flag</div>
      </div>
      <div class="player" id="player">
        <div class="player-top">
          <button class="pp" id="ppBtn" aria-label="Play">▶</button>
          <div class="pinfo">
            <div class="pt" id="ppTitle">Tap a snore below to listen</div>
            <div class="ps" id="ppSub">Loudest events are listed below</div>
          </div>
          <span class="ptag" id="ppTag" style="display:none"></span>
        </div>
        <div class="player-transport" id="ppTransport" style="display:none">
          <span class="ptime" id="ppCur">0:00</span>
          <div class="pseek" id="ppSeek"><div class="pseek-fill" id="ppFill"></div><div class="pseek-knob" id="ppKnob"></div></div>
          <span class="ptime" id="ppDur">0:00</span>
        </div>
        <div class="player-nav" id="ppNav" style="display:none">
          <button class="pnav" id="ppPrev">‹ Prev</button>
          <span class="pnav-label" id="ppIndex"></span>
          <button class="pnav" id="ppNext">Next ›</button>
        </div>
        <div class="player-enh" id="ppEnhWrap" style="display:none">
          <button class="pnav on" id="ppEnh" aria-pressed="true">Clarify audio</button>
          <span class="pnav-label">Cuts low rumble, lifts the level</span>
        </div>
      </div>
    </div>

    <div class="sec-title"><span class="bar"></span>Sleep stages <span style="font-size:11px;color:var(--faint);font-family:'JetBrains Mono',monospace;font-weight:400;margin-left:6px">estimate</span></div>
    <div class="stages-card">
      <canvas id="hypno"></canvas>
      <div class="stage-legend">
        <div class="sg"><i style="background:var(--flag)"></i>Awake ${n.stages?n.stages.awake:0}%</div>
        <div class="sg"><i style="background:#B98CF0"></i>REM ${n.stages?n.stages.rem:0}%</div>
        <div class="sg"><i style="background:var(--sig-b)"></i>Light ${n.stages?n.stages.light:0}%</div>
        <div class="sg"><i style="background:var(--sig-a)"></i>Deep ${n.stages?n.stages.deep:0}%</div>
      </div>
      <div style="font-size:11px;color:var(--faint);margin-top:10px;line-height:1.5">Estimated from sound and movement only — not a clinical sleep study. Real staging needs brain and body sensors.</div>
    </div>

    <div class="sec-title"><span class="bar"></span>Sounds detected</div>
    <div class="sounds-card">
      <div class="snd"><div class="snd-v" style="color:var(--sig-a)">${n.snoreEvents}</div><div class="snd-l">Snoring</div></div>
      <div class="snd"><div class="snd-v" style="color:#B98CF0">${n.movementCount||0}</div><div class="snd-l">Movement</div></div>
      <div class="snd"><div class="snd-v" style="color:var(--muted)">${n.otherCount||0}</div><div class="snd-l">Other</div></div>
    </div>
    <div style="font-size:11px;color:var(--faint);margin-top:8px;line-height:1.5;padding:0 2px">Nocturne separates snoring from body movement and background noise using on-device frequency analysis. Movement feeds the sleep-stage estimate above.</div>

    <div class="sec-title"><span class="bar"></span>Loudest moments</div>
    <div id="eventList"></div>

    ${n.pauses>0?`
    <div class="insight">
      <span class="ic">Worth a conversation with a clinician</span>
      Nocturne flagged <b>${n.pauses} breathing-pause pattern${n.pauses>1?'s':''}</b> — stretches where loud snoring was followed by an extended near-silent gap. This is the acoustic signature that can accompany obstructive sleep apnea. Nocturne can't measure airflow or blood oxygen, so it can't diagnose. Bring this report to a doctor and ask about a home sleep test.
    </div>`:''}

    <div class="sec-title"><span class="bar"></span>Export &amp; share</div>
    <div class="export-row">
      <button class="exp-btn" id="expPdf">Report (PDF)</button>
      <button class="exp-btn" id="expCsv">Data (CSV)</button>
    </div>

    <div class="disclaimer">
      <b>Nocturne is a screening aid, not a medical device.</b> It estimates snoring intensity and flags acoustic patterns from your phone's microphone. It cannot measure airflow, blood oxygen, or AHI, and cannot diagnose or rule out sleep apnea. Loud or frequent snoring, witnessed pauses, gasping, or daytime exhaustion warrant evaluation by a physician via an in-lab or home sleep study.
    </div>
  `;
  drawTimelineReport();
  drawHypnogram();
  renderEvents();
  wirePlayer();
  wireExport();
}

function emptyState(t,p){return `<div class="empty"><div class="e-ico">◐</div><div style="font-family:Fraunces;font-size:18px;color:var(--muted)">${t}</div><p>${p}</p></div>`;}

/* ---------- event list ---------- */
function renderEvents(){
  const n=S.current, el=$('eventList'); if(!el)return;
  const top=[...n.events].sort((a,b)=>(b.lvl||0)-(a.lvl||0)).slice(0,6);
  // the playlist the transport walks through, kept in chronological order
  S._playlist=[...top].sort((a,b)=>a.t-b.t);
  if(!top.length){ el.innerHTML='<div style="color:var(--faint);font-size:13px;padding:10px 4px">No distinct snore events were detected. Quiet night.</div>'; return; }
  const maxLvl=Math.max(...top.map(e=>e.lvl||0),1);
  el.innerHTML=top.map(e=>{
    const hh=Math.floor(e.t/3600), mm=Math.floor((e.t%3600)/60);
    const col = (e.lvl||0)>65?'#F5B660':'linear-gradient(90deg,#38E1C6,#7C7CF0)';
    return `<div class="ev">
      <span class="et">${hh}h ${String(mm).padStart(2,'0')}m</span>
      <span class="ebar"><div style="width:${((e.lvl||0)/maxLvl)*100}%;background:${col}"></div></span>
      <span class="ev-v">lvl ${e.lvl||0} · ${e.dur.toFixed(1)}s</span>
      <button class="play-s" data-ev="${e.id}">▶</button>
    </div>`;
  }).join('');
  el.querySelectorAll('.play-s').forEach(b=>b.onclick=()=>{
    const ev=n.events.find(x=>x.id===b.dataset.ev);
    loadPlayer(ev); startPlayback(ev);
    // the single player sits at the top of the timeline card, two sections above
    // this list — bring it into view so tapping a row visibly opens the player.
    const pl=$('player'); if(pl) pl.scrollIntoView({behavior:'smooth', block:'center'});
  });
}

export { emptyState, loadNightIntoReport, openNight, renderReport };
