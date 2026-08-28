import { REMEDIES } from './log.js';
import { emptyState, openNight } from './report.js';
import { S } from './state.js';
import { clearHistory, saveHistory } from './storage.js';
import { $, band, toast } from './ui.js';

/* ============================================================
   TRENDS — multi-night comparison + remedy effect
   ============================================================ */
function renderTrends(){
  const h=S.history;
  if(!h.length){ $('trendsBody').innerHTML=emptyState('No nights yet','Your trends build up after a few recorded nights.'); return; }
  const scores=h.map(n=>n.score).reverse();
  const avg=Math.round(scores.reduce((a,b)=>a+b,0)/scores.length);
  const totalPauses=h.reduce((a,n)=>a+n.pauses,0);
  const bestScore=Math.min(...scores);

  // --- weekly / monthly aggregates (h is newest-first) ---
  const now=Date.now(), DAY=86400000;
  const within=days=>h.filter(n=>now-new Date(n.date).getTime() <= days*DAY);
  const week=within(7), month=within(30);
  const avgOf=arr=>arr.length? Math.round(arr.reduce((a,n)=>a+n.score,0)/arr.length):null;
  const weekAvg=avgOf(week), monthAvg=avgOf(month);
  // week-over-week delta (this 7 days vs the previous 7)
  const prevWeek=h.filter(n=>{const d=now-new Date(n.date).getTime(); return d>7*DAY && d<=14*DAY;});
  const prevWeekAvg=avgOf(prevWeek);
  const wowDelta=(weekAvg!=null && prevWeekAvg!=null)? weekAvg-prevWeekAvg : null;

  // --- streaks (consecutive nights, newest-first) ---
  // "quiet streak" = consecutive most-recent nights scoring under 40
  let quietStreak=0;
  for(const n of h){ if(n.score<40) quietStreak++; else break; }
  // "pause-free streak" = consecutive most-recent nights with 0 pauses
  let pauseFreeStreak=0;
  for(const n of h){ if(n.pauses===0) pauseFreeStreak++; else break; }
  // best-ever quiet streak anywhere in history
  let bestQuiet=0,run=0;
  for(const n of h){ if(n.score<40){run++; if(run>bestQuiet)bestQuiet=run;} else run=0; }

  // remedy effectiveness: avg score on nights with each remedy vs without
  const remedyEffect={};
  REMEDIES.forEach(r=>{
    const wi=h.filter(n=>n.remedies&&n.remedies.includes(r));
    if(wi.length){ const wo=h.filter(n=>!(n.remedies&&n.remedies.includes(r)));
      const aw=wi.reduce((a,n)=>a+n.score,0)/wi.length;
      const ao=wo.length? wo.reduce((a,n)=>a+n.score,0)/wo.length : aw;
      remedyEffect[r]={delta:Math.round(ao-aw), nights:wi.length};
    }
  });
  const effList=Object.entries(remedyEffect).sort((a,b)=>b[1].delta-a[1].delta);

  const arrow = wowDelta==null?'' : (wowDelta<0?`<span style="color:var(--good)">▼ ${Math.abs(wowDelta)}</span>`:(wowDelta>0?`<span style="color:var(--flag)">▲ ${wowDelta}</span>`:'±0'));

  $('trendsBody').innerHTML=`
    <div class="sec-title"><span class="bar"></span>Snore Score over time</div>
    <div class="trend-card"><canvas id="trend"></canvas></div>
    <div class="trend-row">
      <div class="trend-stat"><div class="tv">${avg}</div><div class="tl">All-time avg</div></div>
      <div class="trend-stat"><div class="tv">${bestScore}</div><div class="tl">Best night</div></div>
      <div class="trend-stat"><div class="tv" style="color:${totalPauses?'var(--flag)':'var(--good)'}">${totalPauses}</div><div class="tl">Total pauses</div></div>
    </div>

    <div class="sec-title"><span class="bar"></span>This week &amp; month</div>
    <div class="trend-row">
      <div class="trend-stat"><div class="tv">${weekAvg!=null?weekAvg:'—'}</div><div class="tl">7-day avg</div></div>
      <div class="trend-stat"><div class="tv">${monthAvg!=null?monthAvg:'—'}</div><div class="tl">30-day avg</div></div>
      <div class="trend-stat"><div class="tv" style="font-size:20px">${arrow||'—'}</div><div class="tl">vs last week</div></div>
    </div>
    <div class="trend-row" style="margin-top:10px">
      <div class="trend-stat"><div class="tv" style="color:var(--good)">${quietStreak}</div><div class="tl">Quiet-night streak</div></div>
      <div class="trend-stat"><div class="tv" style="color:var(--good)">${pauseFreeStreak}</div><div class="tl">Pause-free streak</div></div>
      <div class="trend-stat"><div class="tv">${bestQuiet}</div><div class="tl">Best quiet streak</div></div>
    </div>
    <div style="font-size:11px;color:var(--faint);margin-top:8px;padding:0 4px">A "quiet night" scores under 40. Streaks count your most recent consecutive nights.</div>

    ${effList.length?`
    <div class="sec-title"><span class="bar"></span>What's working</div>
    <div class="trend-card" style="padding:8px 16px">
      ${effList.map(([r,d])=>`
        <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 0;border-bottom:1px solid var(--line)">
          <div><div style="font-size:14px">${r}</div><div style="font-size:11px;color:var(--faint)">${d.nights} night${d.nights>1?'s':''} logged</div></div>
          <div style="font-family:Fraunces;font-size:18px;color:${d.delta>0?'var(--good)':'var(--muted)'}">
            ${d.delta>0?'−'+d.delta:(d.delta<0?'+'+Math.abs(d.delta):'±0')} pts</div>
        </div>`).join('')}
    </div>
    <div style="font-size:11px;color:var(--faint);margin-top:8px;padding:0 4px">Lower is better. Figures compare your score on nights with each remedy against nights without it.</div>
    `:`<div class="insight" style="margin-top:18px"><span class="ic">Tip</span>Log remedies on the <b>Log</b> tab after a few nights and Nocturne will show which ones actually lower your score.</div>`}

    <div class="sec-title"><span class="bar"></span>Night history</div>
    <div class="trend-card" style="padding:8px 16px">
      ${h.map((n,i)=>{
        const bb=band(n.score);
        return `<div class="history-item" data-idx="${i}" role="button" tabindex="0">
          <span class="hi-date">${n.date.toLocaleDateString([],{month:'short',day:'numeric'})}</span>
          <span class="hi-score" style="color:${bb.col}">${n.score}</span>
          <span class="hi-detail">${n.snorePct}% snoring · ${n.pauses} pause${n.pauses!==1?'s':''}${n.remedies&&n.remedies.length?' · '+n.remedies.length+' remed'+(n.remedies.length>1?'ies':'y'):''}</span>
          <span class="hi-bar"><div style="width:${n.score}%"></div></span>
          <button class="hi-del" data-del="${i}" title="Delete this night" aria-label="Delete this night">✕</button>
        </div>`;
      }).join('')}
    </div>
    <div style="font-size:11px;color:var(--faint);margin-top:8px;padding:0 4px">Tap a night to reopen its full report.</div>
    <div style="margin-top:12px;text-align:center"><button class="exp-btn" id="clearHist" style="max-width:200px;margin:0 auto;color:var(--faint)">Clear all history</button></div>
    <div class="disclaimer"><b>Screening aid only.</b> Trends reflect microphone-based estimates, not clinical measurement. Persistent flags deserve a professional sleep evaluation.</div>
  `;
  drawTrend(scores);
  const cb=$('clearHist'); if(cb) cb.onclick=async()=>{ if(confirm('Delete all saved nights? This cannot be undone.')){ await clearHistory(); renderTrends(); toast('History cleared'); } };
  // tap a night to reopen its full report
  $('trendsBody').querySelectorAll('.history-item').forEach(el=>{
    el.addEventListener('click', e=>{
      if(e.target.classList.contains('hi-del')) return; // delete handled separately
      const idx=parseInt(el.dataset.idx,10);
      const night=S.history[idx];
      if(night){ openNight(night); }
    });
  });
  // per-night delete
  $('trendsBody').querySelectorAll('.hi-del').forEach(btn=>{
    btn.addEventListener('click', async e=>{
      e.stopPropagation();
      const idx=parseInt(btn.dataset.del,10);
      const night=S.history[idx];
      if(night && confirm(`Delete the night of ${night.date.toLocaleDateString([],{month:'short',day:'numeric'})}? This cannot be undone.`)){
        S.history.splice(idx,1);
        await saveHistory();
        renderTrends();
        toast('Night deleted');
      }
    });
  });
}
function drawTrend(scores){
  const c=$('trend'); if(!c)return;
  const ctx=c.getContext('2d'), r=window.devicePixelRatio||1;
  c.width=c.clientWidth*r;c.height=c.clientHeight*r;ctx.setTransform(r,0,0,r,0,0);
  const w=c.clientWidth,h=c.clientHeight,pad=20;
  ctx.clearRect(0,0,w,h);
  // gridlines at 25/50/75
  ctx.strokeStyle='rgba(255,255,255,.05)';ctx.lineWidth=1;
  [25,50,75].forEach(v=>{const y=h-pad-(v/100)*(h-pad*2);ctx.beginPath();ctx.moveTo(pad,y);ctx.lineTo(w-pad,y);ctx.stroke();});
  if(scores.length===1){ // single point
    const x=w/2,y=h-pad-(scores[0]/100)*(h-pad*2);
    ctx.fillStyle='#38E1C6';ctx.beginPath();ctx.arc(x,y,5,0,7);ctx.fill();return;
  }
  const xs=i=>pad+(i/(scores.length-1))*(w-pad*2);
  const ys=v=>h-pad-(v/100)*(h-pad*2);
  // area
  const grad=ctx.createLinearGradient(0,0,0,h);
  grad.addColorStop(0,'rgba(124,124,240,.25)');grad.addColorStop(1,'rgba(56,225,198,0)');
  ctx.beginPath();scores.forEach((s,i)=>{i?ctx.lineTo(xs(i),ys(s)):ctx.moveTo(xs(i),ys(s));});
  ctx.lineTo(xs(scores.length-1),h-pad);ctx.lineTo(xs(0),h-pad);ctx.closePath();ctx.fillStyle=grad;ctx.fill();
  // line
  const lg=ctx.createLinearGradient(0,0,w,0);lg.addColorStop(0,'#38E1C6');lg.addColorStop(1,'#7C7CF0');
  ctx.strokeStyle=lg;ctx.lineWidth=2.4;ctx.lineJoin='round';ctx.beginPath();
  scores.forEach((s,i)=>{i?ctx.lineTo(xs(i),ys(s)):ctx.moveTo(xs(i),ys(s));});ctx.stroke();
  // dots
  scores.forEach((s,i)=>{ctx.fillStyle=s>=75?'#F5B660':'#7C7CF0';ctx.beginPath();ctx.arc(xs(i),ys(s),3.5,0,7);ctx.fill();});
}

export { renderTrends };
