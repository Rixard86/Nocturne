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
  el.textContent = `base ${base.toFixed(4)} · amp ${la.toFixed(4)} · lvl ${$('levelVal').textContent}`;
}
function wireDebugToggle(){
  const u=document.querySelector('.halo-unit'); if(!u) return;
  let taps=0,last=0;
  u.addEventListener('click',()=>{
    const t=Date.now(); taps=(t-last<1500)?taps+1:1; last=t;
    if(taps>=3){ taps=0; S._dbg=!S._dbg;
      const d=$('dbgLine'); if(d) d.style.display=S._dbg?'block':'none';
      if(!S._dbg && d) d.textContent='';
      toast(S._dbg?'Debug readout on':'Debug readout off');
    }
  });
}

export { dbgTick, wireDebugToggle };
