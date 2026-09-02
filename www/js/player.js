import { attachEnhancer, setEnhanced, isEnhanced, resumeAudio, audioContext, prepareClip, playableClip } from './audio-enhance.js';
import { drawTimelineReport } from './charts.js';
import { S } from './state.js';
import { $, toast } from './ui.js';

/* ---------- snore playback UI ---------- */
// The player holds a playlist (the shown events) so prev/next can walk through snores.
function playerList(){ return (S.current && S._playlist) || []; }

function loadPlayer(ev){
  S._curEv=ev;
  S._selT = ev? ev.t : null;      // remember selection for the timeline marker
  stopPlayback(); // reset any in-progress audio/timer when switching clips
  if($('tl')) drawTimelineReport(); // redraw so the marker moves to this event
  const hh=Math.floor(ev.t/3600), mm=Math.floor((ev.t%3600)/60);
  $('ppTitle').textContent = ev.kind==='pause' ? 'Breathing-pause pattern' : 'Snore event';
  $('ppSub').textContent = `${hh}h ${String(mm).padStart(2,'0')}m · ${ev.kind==='pause'?Math.round(ev.dur)+'s silent gap':ev.dur.toFixed(1)+'s · level '+(ev.lvl||0)}`;
  const tag=$('ppTag');
  if(ev.kind==='pause'){tag.style.display='';tag.textContent='PAUSE';tag.style.background='rgba(245,182,96,.2)';tag.style.color='#F5B660';}
  else if((ev.lvl||0)>65){tag.style.display='';tag.textContent='LOUD';tag.style.background='rgba(124,124,240,.2)';tag.style.color='#7C7CF0';}
  else {tag.style.display='none';}
  // reveal transport + nav
  $('ppTransport').style.display='flex';
  // The enhancer only applies to real recorded audio, not the synthesized fallback.
  const enhWrap=$('ppEnhWrap');
  if(enhWrap) enhWrap.style.display = ev.clip ? 'flex' : 'none';
  // Start removing the room from this clip now, while the user is still looking at it, so
  // playback can begin straight from their tap without waiting on the analysis.
  if(ev.clip){
    try{ const C=window.Capacitor; prepareClip((C&&C.convertFileSrc)? C.convertFileSrc(ev.clip) : ev.clip); }catch(e){}
  }
  const list=playerList();
  const idx=list.findIndex(x=>x.id===ev.id);
  if(list.length>1 && idx>=0){
    $('ppNav').style.display='flex';
    $('ppIndex').textContent=`${idx+1} / ${list.length}`;
    $('ppPrev').disabled = idx<=0;
    $('ppNext').disabled = idx>=list.length-1;
  } else { $('ppNav').style.display='none'; }
  // reset progress display; total shows the event duration
  setSeek(0);
  $('ppDur').textContent=fmtClock(ev.dur||0);
  $('ppCur').textContent='0:00';
  setPlayIcon(false);
}

function fmtClock(sec){ const s=Math.max(0,Math.round(sec)); return Math.floor(s/60)+':'+String(s%60).padStart(2,'0'); }
function setPlayIcon(playing){ const b=$('ppBtn'); if(b){ b.textContent=playing?'❚❚':'▶'; b.setAttribute('aria-label',playing?'Pause':'Play'); } }
function setSeek(frac){
  frac=Math.max(0,Math.min(1,frac));
  const f=$('ppFill'), k=$('ppKnob');
  if(f) f.style.width=(frac*100)+'%';
  if(k) k.style.left=(frac*100)+'%';
}

// Clarify governs BOTH stages of cleanup, not just the filter chain. The room removal runs
// at clip load and swaps in a processed blob, so leaving the source alone meant "off" still
// played denoised audio with the biquads bypassed - never the recording as captured.
function clipSource(src){
  return isEnhanced() ? playableClip(src) : src;
}

/** Re-point the element at the raw or processed clip, keeping position and play state. */
function swapClipSource(){
  const ev=S._curEv;
  if(!ev || !ev.clip || !S._audioEl) return;
  const C=window.Capacitor;
  const src=(C && C.convertFileSrc)? C.convertFileSrc(ev.clip) : ev.clip;
  const next=clipSource(src);
  if(S._audioEl.src===next) return;
  const at=S._audioEl.currentTime||0;
  const wasPlaying=S._playing;
  // currentTime cannot be set until the new source reports a duration
  S._audioEl.addEventListener('loadedmetadata',()=>{
    try{ S._audioEl.currentTime=Math.min(at, S._audioEl.duration||at); }catch(e){}
    if(wasPlaying) S._audioEl.play().catch(()=>{});
  },{once:true});
  S._audioEl.src=next;
}

// unified play/pause entry point
function togglePlay(){
  if(!S._curEv){ const l=playerList(); if(l.length) loadPlayer(l[0]); else return; }
  if(S._playing){ pausePlayback(); }
  else { startPlayback(S._curEv); }
}

function startPlayback(ev){
  // real recorded clip?
  if(ev && ev.clip){
    try{
      const C=window.Capacitor;
      const src=(C && C.convertFileSrc)? C.convertFileSrc(ev.clip) : ev.clip;
      if(!S._audioEl){
        S._audioEl=new Audio();
        S._audioEl.crossOrigin='anonymous';   // required before Web Audio may read it
        wireAudioEl(S._audioEl);
        attachEnhancer(S._audioEl);
      }
      const playable=clipSource(src);
      if(S._audioEl.src!==playable) S._audioEl.src=playable;
      resumeAudio();   // contexts start suspended until a user gesture
      S._audioEl.play().then(()=>{ S._playing=true; setPlayIcon(true); }).catch(()=>{ synthPlayback(ev); });
      return;
    }catch(e){ /* fall through to synth */ }
  }
  synthPlayback(ev);
}

function wireAudioEl(a){
  a.addEventListener('timeupdate',()=>{
    if(!a.duration||!isFinite(a.duration)) return;
    setSeek(a.currentTime/a.duration);
    $('ppCur').textContent=fmtClock(a.currentTime);
    $('ppDur').textContent=fmtClock(a.duration);
  });
  a.addEventListener('ended',()=>{ S._playing=false; setPlayIcon(false); setSeek(1); });
  a.addEventListener('pause',()=>{ S._playing=false; setPlayIcon(false); });
  a.addEventListener('play',()=>{ S._playing=true; setPlayIcon(true); });
}

// synthesized playback with a simulated progress timer (web/demo, or clip failure)
function synthPlayback(ev){
  const durMs=Math.max(800, Math.min(3000, (ev.dur||1)*1000));
  try{ playSynth(ev); }catch(e){ toast('Playback not available here'); return; }
  S._playing=true; setPlayIcon(true);
  const start=performance.now();
  const totalSec=ev.dur||durMs/1000;
  const tick=()=>{
    if(!S._playing) return;
    const el=(performance.now()-start)/1000;
    const frac=Math.min(1, (performance.now()-start)/durMs);
    setSeek(frac);
    $('ppCur').textContent=fmtClock(Math.min(totalSec, el*(totalSec/(durMs/1000))));
    if(frac>=1){ S._playing=false; setPlayIcon(false); stopSynthTimer(); return; }
    S._synthRaf=requestAnimationFrame(tick);
  };
  S._synthRaf=requestAnimationFrame(tick);
}

/**
 * Cancel the synthesized-playback timer AND forget its handle.
 *
 * The handle doubles as the "this is synth playback, not a real clip" flag that gates the
 * seek bar. Cancelling without clearing it left that flag set for the rest of the session,
 * so one synthesized playback permanently disabled scrubbing on every real clip afterwards.
 */
function stopSynthTimer(){
  if(S._synthRaf) cancelAnimationFrame(S._synthRaf);
  S._synthRaf=0;
}

function pausePlayback(){
  S._playing=false; setPlayIcon(false);
  if(S._audioEl && !S._audioEl.paused){ try{ S._audioEl.pause(); }catch(e){} }
  stopSynthTimer();
}
function stopPlayback(){
  S._playing=false; setPlayIcon(false);
  if(S._audioEl){ try{ S._audioEl.pause(); S._audioEl.currentTime=0; }catch(e){} }
  stopSynthTimer();
  setSeek(0);
  const cur=$('ppCur'); if(cur) cur.textContent='0:00';
}

function stepPlayer(dir){
  const list=playerList(); if(!list.length || !S._curEv) return;
  const idx=list.findIndex(x=>x.id===S._curEv.id);
  const ni=idx+dir;
  if(ni<0 || ni>=list.length) return;
  loadPlayer(list[ni]);
  startPlayback(list[ni]); // auto-play the next/prev snore
}

function wirePlayer(){
  const enh=$('ppEnh');
  // The markup is re-rendered with the button always showing "on", so reflect the real
  // state here or the label drifts out of step with what is actually being played.
  if(enh){
    enh.classList.toggle('on', isEnhanced());
    enh.setAttribute('aria-pressed', String(isEnhanced()));
  }
  if(enh) enh.onclick=()=>{
    const on=!isEnhanced();
    setEnhanced(on);
    swapClipSource();
    enh.classList.toggle('on', on);
    enh.setAttribute('aria-pressed', String(on));
    toast(on?'Audio clarified':'Original audio');
  };
  const b=$('ppBtn'); if(b) b.onclick=()=>togglePlay();
  const pv=$('ppPrev'); if(pv) pv.onclick=()=>stepPlayer(-1);
  const nx=$('ppNext'); if(nx) nx.onclick=()=>stepPlayer(1);
  // seek bar (click + drag) — only meaningful for real audio clips
  const seek=$('ppSeek');
  if(seek){
    const canSeek=()=> S._audioEl && S._audioEl.duration && isFinite(S._audioEl.duration) && !S._synthRaf;
    const seekTo=clientX=>{
      if(!canSeek()) return;              // synth playback isn't seekable
      const r=seek.getBoundingClientRect();
      const frac=Math.max(0,Math.min(1,(clientX-r.left)/r.width));
      setSeek(frac);
      S._audioEl.currentTime=frac*S._audioEl.duration;
      $('ppCur').textContent=fmtClock(S._audioEl.currentTime);
    };
    let dragging=false;
    seek.addEventListener('pointerdown',e=>{ if(!canSeek())return; dragging=true; try{seek.setPointerCapture(e.pointerId);}catch(_){} seekTo(e.clientX); });
    seek.addEventListener('pointermove',e=>{ if(dragging) seekTo(e.clientX); });
    seek.addEventListener('pointerup',()=>{ dragging=false; });
  }
}
function playSynth(ev){
  try{
    const ac=audioContext();
    if(!ac) throw new Error('no audio context');
    if(ev.kind==='pause'){ // a short rumble, then silence, then gasp
      rumble(ac,0,0.6,90); setTimeout(()=>{},10);
      gasp(ac,0.6+ (ev.dur>12?1.2:0.9));
    } else {
      const dur=Math.min(3,Math.max(1,ev.dur));
      rumble(ac,0,dur, (ev.lvl||0)>65?70:110);
    }
  }catch(e){ toast('Playback not available here'); throw e; }
}
function rumble(ac,start,dur,freq){
  const t0=ac.currentTime+start;
  const o=ac.createOscillator(), o2=ac.createOscillator(), g=ac.createGain(), lp=ac.createBiquadFilter();
  o.type='sawtooth';o2.type='triangle';o.frequency.value=freq;o2.frequency.value=freq*1.5;
  lp.type='lowpass';lp.frequency.value=400;
  g.gain.setValueAtTime(0,t0);
  // snore = rising-falling amplitude with a flutter
  for(let i=0;i<dur*10;i++){
    const tt=t0+i/10, env=Math.sin((i/(dur*10))*Math.PI)*(0.5+0.5*Math.sin(i*1.3));
    g.gain.linearRampToValueAtTime(Math.max(0,env*0.25),tt);
  }
  g.gain.linearRampToValueAtTime(0,t0+dur);
  o.connect(lp);o2.connect(lp);lp.connect(g);g.connect(ac.destination);
  o.start(t0);o2.start(t0);o.stop(t0+dur);o2.stop(t0+dur);
}
function gasp(ac,start){
  const t0=ac.currentTime+start;
  const n=ac.createBufferSource(), b=ac.createBuffer(1,ac.sampleRate*0.5,ac.sampleRate);
  const d=b.getChannelData(0); for(let i=0;i<d.length;i++) d[i]=(Math.random()*2-1)*Math.sin((i/d.length)*Math.PI);
  n.buffer=b; const g=ac.createGain(), hp=ac.createBiquadFilter(); hp.type='highpass';hp.frequency.value=600;
  g.gain.setValueAtTime(0,t0);g.gain.linearRampToValueAtTime(0.3,t0+0.08);g.gain.linearRampToValueAtTime(0,t0+0.45);
  n.connect(hp);hp.connect(g);g.connect(ac.destination);n.start(t0);
}

export { loadPlayer, startPlayback, stopPlayback, wirePlayer };
