import { S } from './state.js';
import { $, toast } from './ui.js';

// --- dev diagnostic: live baseline / amp / level readout (triple-tap "sound level") ---
// baseline is the value set at calibration; amp is the real RMS (updates ~1x/s via the
// timeline sample); level updates ~10x/s. If amp moves on sound but level doesn't, the
// baseline is pinning the scale; if amp doesn't move at all, the mic isn't capturing.
function dbgTick(){
  if(!S._dbg) return;
  const el=$('dbgLine'); if(!el) return;
  const la = S.samples.length ? (S.samples[S.samples.length-1].amp||0) : 0;
  const base = (S._liveBase!=null ? S._liveBase : (S.baseline||0)); // live floor, not the frozen calib value
  const rec = S._rawCapture ? ' · REC' : '';
  el.textContent = `base ${base.toFixed(4)} · amp ${la.toFixed(4)} · lvl ${$('levelVal').textContent}${rec}`;
}
function wireDebugToggle(){
  const u=document.querySelector('.halo-unit'); if(!u) return;
  let taps=0,last=0;
  u.addEventListener('click',()=>{
    const t=Date.now(); taps=(t-last<1500)?taps+1:1; last=t;
    if(taps>=3){ taps=0; S._dbg=!S._dbg;
      const d=$('dbgLine'); if(d) d.style.display=S._dbg?'block':'none';
      if(!S._dbg && d) d.textContent='';
      // render immediately: an empty line has no height, so it could not be tapped to
      // arm raw capture before a recording starts
      if(S._dbg) dbgTick();
      toast(S._dbg?'Debug readout on':'Debug readout off');
    }
  });
}

// --- dev diagnostic: arm raw-night capture (tap the debug readout once it is visible) ---
// Writes the whole night to night.wav + night.chunks alongside the event log, which
// `npm run replay` feeds back through the detector. Armed per recording, not persisted:
// it costs ~500 MB a night, so it should never survive a restart unnoticed.
function wireRawCaptureToggle(){
  const d=$('dbgLine'); if(!d) return;
  d.addEventListener('click',(e)=>{
    e.stopPropagation();
    S._rawCapture=!S._rawCapture;
    // re-render now: while idle nothing else ticks, so without this the REC marker only
    // appeared once recording had already started — too late to check before starting
    dbgTick();
    toast(S._rawCapture?'Raw capture armed for next recording':'Raw capture off');
  });
}

export { dbgTick, wireDebugToggle, wireRawCaptureToggle };
