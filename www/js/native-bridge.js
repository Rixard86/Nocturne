import { dbgTick } from './debug.js';
import { finalize } from './finalize.js';
import { drawHalo, nativeAmp, resetHalo, setNativeAmp } from './halo.js';
import { switchView } from './navigation.js';
import { recBtn, stopRec } from './recorder.js';
import { S, snoreRatio } from './state.js';
import { saveSettings } from './storage.js';
import { $, fmtDur, toast } from './ui.js';

/* ============================================================
   NATIVE CAPTURE BRIDGE (Android foreground service)
   On Android we hand recording to a native foreground service so it
   survives screen-off. Plugin events feed the SAME S.* state and UI
   the web loop uses, so finalize()/halo work unchanged. On the web we
   fall back to the WebAudio path below.
   ============================================================ */
function nativePlugin(){
  const C=window.Capacitor;
  if(C && C.isNativePlatform && C.isNativePlatform() && C.Plugins && C.Plugins.Nocturne) return C.Plugins.Nocturne;
  return null;
}
let nativeListeners=[];
let nativeHaloRaf=null;


async function startNative(plugin){
  // one-time: ask Android to exempt Nocturne from battery optimization so the OS won't
  // kill the recording service overnight (Samsung especially). Only prompt once.
  try{
    if(!S._askedBattery && plugin.isIgnoringBatteryOptimizations){
      const r=await plugin.isIgnoringBatteryOptimizations();
      if(r && !r.ignoring){
        S._askedBattery=true; saveSettings();
        if(confirm('For reliable overnight recording, allow Nocturne to keep running in the background? This prevents Android from stopping it while you sleep.')){
          try{ await plugin.requestIgnoreBatteryOptimizations(); }catch(e){}
        }
      } else { S._askedBattery=true; }
    }
  }catch(e){}
  // reset state
  S.recording=true; S.native=true; S.startTime=Date.now();
  S.samples=[]; S.events=[]; S.pauses=[]; S.recordings={}; S.sounds=[];
  S.inSnore=false; S.quietSince=0; S.loudSince=0; S.snoreEp=null; S.silentSince=0; S.lastEpLoud=0; S.lastEpDur=0;
  S.calibrating=true; S.baseline=0.012;
  recBtn.classList.add('recording');
  $('haloState').textContent='Calibrating';
  $('haloSub').textContent='Measuring the room…';
  $('recHint').textContent='Recording. You can lock the screen — Nocturne keeps listening in the background. Tap stop when you wake.';

  // wire events
  const add=async (name,fn)=>{ const h=await plugin.addListener(name,fn); nativeListeners.push(h); };
  await add('nocturneCalibrating', e=>{
    setNativeAmp(e.amp||0);
    $('levelVal').textContent=Math.ceil(e.secondsLeft||0);
    $('haloSub').textContent='Measuring the room…';
  });
  await add('nocturneState', e=>{
    if(e.state==='listening'){
      S.calibrating=false;
      S.baseline=e.baseline||S.baseline;
      $('haloState').textContent='Listening';
    } else if(e.state==='stopped' || e.state==='auto-stopped'){
      // native auto-stopped (12h cap) — finalize what we have so it isn't lost
      if(S.recording){ stopNative(); if(e.state==='auto-stopped') toast('Recording auto-stopped after 12 hours.'); }
    }
  });
  await add('nocturneSample', e=>{ S.samples.push({t:e.t, amp:e.amp, lvl:e.level}); });
  await add('nocturneSnore', e=>{
    S.events.push({id:'e'+S.events.length, t:e.t, dur:e.dur, lvl:e.level, kind:'snore', clip:e.clip||''});
    $('lsSnore').textContent=e.count;
  });
  await add('nocturneSound', e=>{
    // movement / other classified sounds — feed staging, not snore stats
    S.sounds.push({t:e.t, dur:e.dur, lvl:e.level, kind:e.kind});
  });
  await add('nocturnePause', e=>{
    S.pauses.push({t:e.t, dur:e.dur, clip:e.clip||''});
    $('lsPause').textContent=e.count;
  });
  await add('nocturneLevel', e=>{
    setNativeAmp((e.level||0)/100*0.2); // map 0-100 back to an amp-ish value for the halo
    if(e.baseline!=null) S._liveBase=e.baseline; // live floor (native keeps adapting it)
    $('levelVal').textContent=e.level;
    $('lsElapsed').textContent=fmtDur(e.elapsed||0);
    if(e.snoring) $('haloSub').textContent='Snoring detected';
    else $('haloSub').textContent='Breathing steady';
  });
  await add('nocturneError', e=>{ toast(e.message||'Recording error'); stopRec(); });
  await add('nocturneAlarm', e=>{ toast('⏰ Smart alarm — good morning'); });

  // halo animation loop (native): drive rings from latest level
  const animate=()=>{ if(!S.recording||!S.native) return; drawHalo(nativeAmp(), $('haloSub').textContent==='Snoring detected'); dbgTick(); nativeHaloRaf=requestAnimationFrame(animate); };
  animate();

  try{
    const opts={ sensitivity: snoreRatio() };
    if(S.alarm && S.alarm.on){
      opts.alarmEnabled=true;
      opts.alarmTime=S.alarm.time;       // "HH:MM"
      opts.alarmWindowMin=S.alarm.windowMin;
    }
    await plugin.start(opts);
  }catch(err){
    stopNative();
    toast('Microphone permission denied. Enable it in Settings, or use the sample night.');
  }
}

// On launch, recover a recording the UI may have missed (OS killed the WebView while the
// foreground service kept running). Reads the persisted session and either resumes the
// live UI (still recording) or finalizes an orphaned night (service already stopped).
async function reattachSession(plugin){
  if(!plugin || !plugin.getState) return false;
  let st;
  try{ st = await plugin.getState(); }catch(e){ return false; }
  if(!st || !st.events || !st.events.length) return false;

  // rebuild accumulated state from the event log
  const rebuilt={ samples:[], events:[], sounds:[], pauses:[] };
  let snoreN=0, pauseN=0;
  for(const ev of st.events){
    switch(ev.e){
      case 'sample': rebuilt.samples.push({t:ev.t, amp:ev.amp, lvl:ev.lvl}); break;
      case 'snore': snoreN++; rebuilt.events.push({id:'e'+rebuilt.events.length, t:ev.t, dur:ev.dur, lvl:ev.lvl, kind:'snore', clip:ev.clip||''}); break;
      case 'sound': rebuilt.sounds.push({t:ev.t, dur:ev.dur, lvl:ev.lvl, kind:ev.kind}); break;
      case 'pause': pauseN++; rebuilt.pauses.push({t:ev.t, dur:ev.dur, clip:ev.clip||''}); break;
    }
  }
  if(rebuilt.samples.length<5 && !(st.active && st.running)) return false; // nothing worth recovering

  if(st.active && st.running){
    // recording is STILL live — resume the recording UI and re-wire listeners
    S.samples=rebuilt.samples; S.events=rebuilt.events; S.sounds=rebuilt.sounds; S.pauses=rebuilt.pauses;
    S.startTime = st.startMs || (Date.now()-rebuilt.samples[rebuilt.samples.length-1].t*1000);
    await resumeNativeListeners(plugin);
    $('lsSnore').textContent=snoreN; $('lsPause').textContent=pauseN;
    switchView('record');
    toast('Reconnected to your in-progress recording.');
    return true;
  } else {
    // service stopped while the UI was gone — reconstruct and finalize so it isn't lost
    S.samples=rebuilt.samples; S.events=rebuilt.events; S.sounds=rebuilt.sounds; S.pauses=rebuilt.pauses;
    S.startTime = st.startMs || Date.now();
    S.native=true;
    finalize(false);
    S.native=false;
    switchView('report');
    toast('Recovered a recording that ended while the app was closed.');
    return true;
  }
}

// Re-wire native listeners to a recording already in progress (used by reattach).
async function resumeNativeListeners(plugin){
  S.recording=true; S.native=true; S.calibrating=false;
  recBtn.classList.add('recording');
  $('haloState').textContent='Listening';
  $('recHint').textContent='Recording. You can lock the screen — Nocturne keeps listening in the background. Tap stop when you wake.';
  const add=async (name,fn)=>{ const h=await plugin.addListener(name,fn); nativeListeners.push(h); };
  await add('nocturneState', e=>{ if(e.state==='listening'){ S.calibrating=false; S.baseline=e.baseline||S.baseline; } else if(e.state==='stopped'||e.state==='auto-stopped'){ if(S.recording){ stopNative(); if(e.state==='auto-stopped') toast('Recording auto-stopped after 12 hours.'); } } });
  await add('nocturneSample', e=>{ S.samples.push({t:e.t, amp:e.amp, lvl:e.level}); });
  await add('nocturneSnore', e=>{ S.events.push({id:'e'+S.events.length, t:e.t, dur:e.dur, lvl:e.level, kind:'snore', clip:e.clip||''}); $('lsSnore').textContent=e.count; });
  await add('nocturneSound', e=>{ S.sounds.push({t:e.t, dur:e.dur, lvl:e.level, kind:e.kind}); });
  await add('nocturnePause', e=>{ S.pauses.push({t:e.t, dur:e.dur, clip:e.clip||''}); $('lsPause').textContent=e.count; });
  await add('nocturneLevel', e=>{ setNativeAmp((e.level||0)/100*0.2); if(e.baseline!=null) S._liveBase=e.baseline; $('levelVal').textContent=e.level; $('lsElapsed').textContent=fmtDur(e.elapsed||0); $('haloSub').textContent=e.snoring?'Snoring detected':'Breathing steady'; });
  await add('nocturneError', e=>{ toast(e.message||'Recording error'); stopRec(); });
  await add('nocturneAlarm', e=>{ toast('⏰ Smart alarm — good morning'); });
  const animate=()=>{ if(!S.recording||!S.native) return; drawHalo(nativeAmp(), $('haloSub').textContent==='Snoring detected'); dbgTick(); nativeHaloRaf=requestAnimationFrame(animate); };
  animate();
}

async function stopNative(){
  const plugin=nativePlugin();
  S.recording=false; S.native=false;
  const wasCalibrating=S.calibrating; S.calibrating=false;
  recBtn.classList.remove('recording');
  if(nativeHaloRaf) cancelAnimationFrame(nativeHaloRaf);
  resetHalo();
  try{ if(plugin) await plugin.stop(); }catch(e){}
  for(const h of nativeListeners){ try{ await h.remove(); }catch(e){} }
  nativeListeners=[];
  $('haloState').textContent='Idle';
  $('levelVal').textContent='—';
  $('haloSub').textContent='Tap record to begin';
  $('recHint').textContent="Place your phone face-down on the mattress or nightstand, within arm's reach. Keep it plugged in.";
  if(wasCalibrating){ toast('Stopped during calibration — nothing recorded.'); return; }
  if(S.samples.length>5){ finalize(false); switchView('report'); }
  else toast('Night was too short to analyze. Try the sample.');
}

export { nativePlugin, reattachSession, startNative, stopNative };
