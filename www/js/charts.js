import { loadPlayer } from './player.js';
import { S } from './state.js';
import { $ } from './ui.js';

/* ---------- timeline canvas (report) ---------- */
function drawTimelineReport(){
  const c=$('tl'); if(!c)return;
  const n=S.current; if(!n) return;
  if(!c.clientWidth) return; // view hidden; redrawn on tab switch / resize
  const ctx=c.getContext('2d'), r=window.devicePixelRatio||1;
  c.width=c.clientWidth*r; c.height=c.clientHeight*r; ctx.setTransform(r,0,0,r,0,0);
  const w=c.clientWidth,h=c.clientHeight;
  ctx.clearRect(0,0,w,h);
  const total=n.durationSec||1;
  // Downsample to <=800 buckets (max amp per bucket). A full night has ~23,000
  // one-second samples; drawing them all is slow and the old spread-based max
  // risked a stack overflow.
  const buckets=Math.max(2, Math.min(800, Math.floor(w)));
  const agg=new Array(buckets).fill(0);
  // full samples for the current night; persisted mini-timeline for reopened past nights
  const src = (n.samples && n.samples.length) ? n.samples : (n.timelineMini || []);
  for(const s of src){
    const bi=Math.min(buckets-1, Math.max(0, Math.floor((s.t/total)*buckets)));
    if(s.amp>agg[bi]) agg[bi]=s.amp;
  }
  // Robust normalization: scale to the 97th percentile, clamped, so one loud spike
  // (a cough, a bump) doesn't flatten the whole night's waveform to the baseline.
  const nz=agg.filter(v=>v>0).sort((a,b)=>a-b);
  const p97=nz.length? nz[Math.min(nz.length-1, Math.floor(nz.length*0.97))] : 0.05;
  const max=Math.max(0.02, p97);
  // pause bands
  n.pauseList.forEach(p=>{
    const x=(p.t/total)*w, ww=Math.max(2,(p.dur/total)*w*6);
    ctx.fillStyle='rgba(245,182,96,.16)';ctx.fillRect(x,0,ww,h);
    ctx.fillStyle='#F5B660';ctx.fillRect(x,0,1.5,h);
  });
  // waveform (over buckets)
  const grad=ctx.createLinearGradient(0,0,w,0);
  grad.addColorStop(0,'#38E1C6');grad.addColorStop(1,'#7C7CF0');
  ctx.strokeStyle=grad;ctx.lineWidth=1.4;ctx.beginPath();
  for(let i=0;i<buckets;i++){
    const x=(i/(buckets-1))*w;
    const v=Math.min(1, agg[i]/max);
    const y=h-v*(h-6)-2;
    i?ctx.lineTo(x,y):ctx.moveTo(x,y);
  }
  ctx.stroke();
  // fill
  ctx.lineTo(w,h);ctx.lineTo(0,h);ctx.closePath();
  const fg=ctx.createLinearGradient(0,0,0,h);
  fg.addColorStop(0,'rgba(124,124,240,.18)');fg.addColorStop(1,'rgba(56,225,198,0)');
  ctx.fillStyle=fg;ctx.fill();
  // axis labels
  const ax=$('tlAxis'); const hrs=total/3600;
  ax.innerHTML='';
  for(let i=0;i<=4;i++){const sp=document.createElement('span');sp.textContent=(i*hrs/4).toFixed(1)+'h';ax.appendChild(sp);}
  // selection marker — shows where the user tapped / which event is loaded
  if(S._selT!=null && S._selT>=0 && S._selT<=total){
    const x=(S._selT/total)*w;
    ctx.save();
    // vertical line
    ctx.strokeStyle='rgba(255,255,255,.85)';
    ctx.lineWidth=1.5;
    ctx.setLineDash([3,3]);
    ctx.beginPath();ctx.moveTo(x,6);ctx.lineTo(x,h);ctx.stroke();
    ctx.setLineDash([]);
    // dot at top
    ctx.fillStyle='#fff';
    ctx.beginPath();ctx.arc(x,6,4,0,Math.PI*2);ctx.fill();
    ctx.strokeStyle='rgba(124,124,240,.9)';ctx.lineWidth=2;
    ctx.beginPath();ctx.arc(x,6,4,0,Math.PI*2);ctx.stroke();
    ctx.restore();
  }
  // click to seek
  c.onclick=e=>{
    const rect=c.getBoundingClientRect();
    const frac=(e.clientX-rect.left)/rect.width;
    const t=frac*total;
    // nearest event
    let near=null,best=1e9;
    n.events.forEach(ev=>{const d=Math.abs(ev.t-t);if(d<best){best=d;near=ev;}});
    let pNear=null; n.pauseList.forEach(p=>{if(Math.abs(p.t-t)<120)pNear=p;});
    // Set the playlist to whatever kind was tapped, so Prev/Next walk that series. The
    // playlist otherwise only ever held the six loudest snores, so tapping anything else on
    // the timeline left the transport unable to find the current event and it hid its own
    // nav - which looked like the Next button vanishing at random.
    if(pNear){ openFromTimeline(pauseSeries(n), p => p.t===pNear.t); }
    else if(near){ openFromTimeline(snoreSeries(n), e => e.t===near.t); }
  };
}

/** Pauses as playable events. They are stored without ids, and the transport needs one. */
function pauseSeries(night){
  return (night.pauseList||[]).map((p,i)=>({ id:'pause'+i, t:p.t, dur:p.dur, kind:'pause', clip:p.clip||'', lvl:0 }));
}

/** Every snore with audio, in time order - not just the six the report lists. */
function snoreSeries(night){
  return (night.events||[]).filter(e=>e.clip).sort((a,b)=>a.t-b.t);
}

/** Make `series` the transport's playlist and open the entry that `match` picks out. */
function openFromTimeline(series, match){
  if(!series.length) return;
  const idx = Math.max(0, series.findIndex(match));
  S._playlist = series;
  loadPlayer(series[idx]);
}

/* live timeline (small, during recording — drawn into halo area? we keep report canvas only) */
function drawTimelineLive(){ /* live view uses halo; timeline shown in report */ }

/* ---------- hypnogram (sleep stages) ---------- */
const STAGE_COLORS={awake:'#F5B660', rem:'#B98CF0', light:'#7C7CF0', deep:'#38E1C6'};
const STAGE_Y={awake:0, rem:1, light:2, deep:3};
function drawHypnogram(){
  const c=$('hypno'); if(!c)return;
  if(!c.clientWidth) return; // view hidden; redrawn on tab switch / resize
  // the wearable's own staging wins when the night has it; the acoustic one is a proxy for
  // exactly this and has no reason to be preferred once the real thing is present
  const n=S.current; const hyp=(n&&(n.wearableHypnogram||n.hypnogram))||[];
  const ctx=c.getContext('2d'), r=window.devicePixelRatio||1;
  c.width=c.clientWidth*r; c.height=c.clientHeight*r; ctx.setTransform(r,0,0,r,0,0);
  const w=c.clientWidth,h=c.clientHeight;
  ctx.clearRect(0,0,w,h);
  if(!hyp.length){ ctx.fillStyle='#64748B';ctx.font='12px monospace';ctx.fillText('No stage data',10,h/2); return; }
  const rows=4, rowH=h/rows, pad=3;
  // faint row guides
  for(let i=0;i<rows;i++){ ctx.fillStyle='rgba(255,255,255,.03)'; ctx.fillRect(0,i*rowH,w,rowH-1); }
  const bw=w/hyp.length;
  hyp.forEach((b,i)=>{
    const y=STAGE_Y[b.stage]*rowH;
    ctx.fillStyle=STAGE_COLORS[b.stage]||'#7C7CF0';
    ctx.globalAlpha=0.9;
    ctx.fillRect(i*bw, y+pad, Math.max(1,bw-0.5), rowH-pad*2);
  });
  ctx.globalAlpha=1;
  // connecting step line across the middle of each block's row
  ctx.strokeStyle='rgba(231,238,248,.35)'; ctx.lineWidth=1; ctx.beginPath();
  hyp.forEach((b,i)=>{
    const x=i*bw+bw/2, y=STAGE_Y[b.stage]*rowH+rowH/2;
    i?ctx.lineTo(x,y):ctx.moveTo(x,y);
  });
  ctx.stroke();
}

export { drawHypnogram, drawTimelineLive, drawTimelineReport };
