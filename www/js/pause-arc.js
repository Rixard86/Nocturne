import { S } from './state.js';
import { $ } from './ui.js';
import { clipEnvelope } from './audio-enhance.js';

/* ---------- the pause arc ---------- */


// Mirrors PauseDetector.PRE_ROLL_SEC / POST_ROLL_SEC: a pause clip is that much breathing,
// then the gap itself, then the recovery breath.
const PAUSE_PRE_ROLL_SEC = 3;
const PAUSE_POST_ROLL_SEC = 4;

// What a convincing arc looks like, from the one human-confirmed pause so far: it dropped
// 14.2 dB into the gap and came back 8.4 dB. These are a reading aid, not a gate.
const DROP_MIN_DB = 6;
const RECOVERY_MIN_DB = 6;

function canvas(){ return $('ppArc'); }

/** Where the gap sits within the clip, as fractions of its length. */
function gapBounds(ev){
  const el = S._audioEl;
  const total = (el && el.duration && isFinite(el.duration))
    ? el.duration
    : PAUSE_PRE_ROLL_SEC + (ev.dur || 0) + PAUSE_POST_ROLL_SEC;
  if (!(total > 0)) return null;
  return { from: PAUSE_PRE_ROLL_SEC / total, to: Math.min(1, (PAUSE_PRE_ROLL_SEC + (ev.dur || 0)) / total), total };
}

let cached = null;

/**
 * State the shape in numbers, because that is the judgement being asked for. A real
 * obstructive event drops into the gap and comes back out of it with a gasp; a gap that
 * never recovers is more likely to be quiet breathing that was simply never audible.
 */
function describeShape(ev, env){
  const el = $('ppShape'); if(!el) return;
  const bounds = gapBounds(ev);
  if(!env || !env.length || !bounds){ el.textContent = ''; return; }
  const at = f => Math.max(0, Math.min(env.length-1, Math.round(f*env.length)));
  const mean = (a, z) => { let s=0,n=0; for(let i=a;i<z;i++){ s+=env[i]; n++; } return n? s/n : 0; };
  const loudest = (a, z) => { let m=0; for(let i=a;i<z;i++) if(env[i]>m) m=env[i]; return m; };
  // Breathing and a recovery gasp are brief and intermittent, so averaging across the roll
  // dilutes them into the quiet between breaths - measured on a real clip that turned a
  // genuine 6.7 dB recovery into under 6 and read as "none". Take the loudest moment of each
  // roll against the gap's own level, which is what the eye is doing on the picture anyway.
  const pre = loudest(0, at(bounds.from));
  const gap = mean(at(bounds.from), at(bounds.to));
  const post = loudest(at(bounds.to), env.length);
  if(gap <= 0){ el.textContent = ''; return; }
  const drop = 20*Math.log10(Math.max(pre,1e-9)/gap);
  const rise = 20*Math.log10(Math.max(post,1e-9)/gap);
  const recovery = rise >= RECOVERY_MIN_DB ? `+${rise.toFixed(0)} dB back` : 'no clear recovery';
  el.textContent = `${drop.toFixed(0)} dB into the gap · ${recovery}`;
  el.style.color = (drop >= DROP_MIN_DB && rise >= RECOVERY_MIN_DB) ? '#5BD6A8' : '#97a3b8';
}

function drawArc(ev, env){
  const c = canvas(); if(!c) return;
  const bounds = gapBounds(ev); if(!bounds) return;
  const r = window.devicePixelRatio || 1;
  const w = c.clientWidth, h = c.clientHeight;
  c.width = w * r; c.height = h * r;
  const g = c.getContext('2d');
  g.setTransform(r,0,0,r,0,0);
  g.clearRect(0,0,w,h);

  // the gap, shaded, so the eye lands on it before anything else
  g.fillStyle = 'rgba(245,182,96,.13)';
  g.fillRect(w*bounds.from, 0, w*(bounds.to-bounds.from), h);
  g.strokeStyle = 'rgba(245,182,96,.45)'; g.lineWidth = 1;
  for(const x of [w*bounds.from, w*bounds.to]){ g.beginPath(); g.moveTo(x,0); g.lineTo(x,h); g.stroke(); }

  if(env && env.length){
    let peak = 0; for(const v of env) if(v>peak) peak = v;
    const scale = peak>0 ? (h/2-6)/peak : 0;
    for(let i=0;i<env.length;i++){
      const x = (i/env.length)*w, amp = env[i]*scale;
      const inGap = (i/env.length) >= bounds.from && (i/env.length) < bounds.to;
      g.strokeStyle = inGap ? 'rgba(245,182,96,.85)' : 'rgba(124,180,240,.85)';
      g.beginPath(); g.moveTo(x, h/2-amp); g.lineTo(x, h/2+amp); g.stroke();
    }
  }

  g.fillStyle = 'rgba(232,236,244,.55)';
  g.font = '10px ui-monospace, monospace';
  const gapX = w*bounds.from + 4;
  if (gapX > 62) g.fillText('breathing', 4, 12);          // only when it will not collide
  g.fillText(Math.round(ev.dur||0)+'s silent', gapX, 12);
  if (w - w*bounds.to > 56) g.fillText('recovery', w*bounds.to+4, 12);
  describeShape(ev, env);

  const el = S._audioEl;
  if(el && el.duration && isFinite(el.duration) && el.currentTime>0){
    const x = (el.currentTime/el.duration)*w;
    g.strokeStyle = '#fff'; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(x,0); g.lineTo(x,h); g.stroke();
  }
}

/** Show the arc for a pause, hide it for anything else. */
export function showPauseArc(ev, url){
  const c = canvas(); if(!c) return;
  const shape = $('ppShape');
  if(!ev || ev.kind!=='pause' || !ev.clip){
    c.style.display='none';
    if(shape) shape.textContent = '';   // or the previous pause's verdict sits under a snore
    return;
  }
  c.style.display='block';
  cached = null;
  drawArc(ev, null);
  clipEnvelope(url).then(env => { if(S._curEv===ev){ cached = env; drawArc(ev, env); } });
}

/** Redraw with the cached envelope - used to move the playhead as the clip plays. */
export function redrawPauseArc(ev){ drawArc(ev, cached); }

