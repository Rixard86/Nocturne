import { S } from './state.js';
import { $ } from './ui.js';

/* ---------- the signature breath halo ---------- */
const halo=$('halo'), hctx=halo.getContext('2d'), haloWrap=document.querySelector('.halo-wrap');
function sizeHalo(){const r=window.devicePixelRatio||1;halo.width=halo.clientWidth*r;halo.height=halo.clientHeight*r;hctx.setTransform(r,0,0,r,0,0);}
let haloPhase=0, haloAmp=0;
// Latest amplitude reported by the native capture service. It lives here rather than
// in the bridge because the halo is its only consumer and resetHalo() clears it.
let nativeHaloAmp=0;
function nativeAmp(){ return nativeHaloAmp; }
function setNativeAmp(v){ nativeHaloAmp=v; }
function drawHalo(amp, snoring){
  haloAmp = haloAmp*0.82 + (amp||0)*0.18;
  const w=halo.clientWidth,h=halo.clientHeight;
  hctx.clearRect(0,0,w,h);
  // The canvas is a full-bleed background layer, so its own centre isn't where the halo
  // sits — centre the rings on the halo text block, and scale them to the halo box (not the
  // canvas) so the soft glow spills across the whole background while the rings stay put.
  const cr=halo.getBoundingClientRect(), wr=haloWrap.getBoundingClientRect();
  const cx=(wr.left-cr.left)+wr.width/2, cy=(wr.top-cr.top)+wr.height/2;
  const hs=Math.min(wr.width, wr.height)||300;
  haloPhase+=0.02;
  const base=46;
  // Reactivity tuned for dynamic range: quiet sounds nudge the rings, loud sounds
  // push them out dramatically. The curve keeps headroom so volume keeps reading
  // as expansion across the whole range rather than saturating early.
  const maxReact = hs*0.40;                   // outer rings scale to the halo box
  const drive = Math.pow(haloAmp, 0.9) * 1500; // steep but not saturating early
  const react = Math.min(maxReact, drive);
  for(let i=4;i>=0;i--){
    // outer rings (higher i) travel farther on loud sounds for a blast-outward feel
    const spread = react * (0.55 + (i/4)*0.85);
    const rr=base + spread + Math.sin(haloPhase+i)*4 + i*18;
    const g=hctx.createRadialGradient(cx,cy,rr*0.6,cx,cy,rr);
    const a=(0.10+ (snoring?0.06:0))*(1-i*0.14);
    if(snoring){g.addColorStop(0,`rgba(245,182,96,${a*1.4})`);g.addColorStop(1,`rgba(224,138,75,0)`);}
    else{g.addColorStop(0,`rgba(56,225,198,${a})`);g.addColorStop(1,`rgba(124,124,240,0)`);}
    hctx.beginPath();hctx.arc(cx,cy,rr,0,Math.PI*2);hctx.fillStyle=g;hctx.fill();
  }
  // crisp core ring — sits outside the centered text block so they never overlap
  hctx.beginPath();hctx.arc(cx,cy,base+30+react*0.5,0,Math.PI*2);
  hctx.strokeStyle=snoring?'rgba(245,182,96,.55)':'rgba(56,225,198,.45)';hctx.lineWidth=1.5;hctx.stroke();
}
// idle ambient animation
let idleRaf=null;
function idleHalo(){ if(!S.recording){ drawHalo(0.004,false); idleRaf=requestAnimationFrame(idleHalo); } else { idleRaf=null; } }
// Restore the halo to its calm idle state when a recording stops — otherwise it freezes on
// the last (expanded/amber) frame. Collapses the rings and restarts the idle animation.
function resetHalo(){
  haloAmp=0; nativeHaloAmp=0;
  hctx.clearRect(0,0,halo.clientWidth,halo.clientHeight);
  if(idleRaf) cancelAnimationFrame(idleRaf);
  idleRaf=null;
  if(!S.recording) idleHalo();
}

export { drawHalo, idleHalo, nativeAmp, resetHalo, setNativeAmp, sizeHalo };
