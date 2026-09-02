import { dbgTick } from './debug.js';
import { finalize } from './finalize.js';
import { drawHalo, nativeAmp, resetHalo, setNativeAmp } from './halo.js';
import { switchView } from './navigation.js';
import { recBtn, stopRec } from './recorder.js';
import { S, snoreRatio } from './state.js';

// The service writes its closing events just after stop() resolves; give them time to land.
const FINAL_FLUSH_MS = 600;

// Capture watchdog. Every failure in this area used to be invisible: the service could die
// or its audio stream go silent while the UI sat showing a healthy recording all night, and
// the first anyone knew was an empty report in the morning. Level events arrive ~10x a
// second, so a minute without one means capture has stopped, whatever the UI believes.
const HEARTBEAT_CHECK_MS = 30000;
const HEARTBEAT_STALE_MS = 60000;
const RECORDING_HINT = 'Recording. You can lock the screen — Nocturne keeps listening in the background. Tap stop when you wake.';
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
  startCaptureWatchdog(plugin);
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
    S.events.push({id:'e'+S.events.length, t:e.t, dur:e.dur, lvl:e.level, ratio:e.ratio||0, kind:'snore', clip:e.clip||''});
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
    noteHeartbeat();
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
    const opts={ sensitivity: snoreRatio(), rawCapture: !!S._rawCapture };
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

/**
 * Rebuild the night from the service's own event log.
 *
 * The log is the only complete record. Anything the UI holds in memory is whatever happened
 * to arrive while the WebView was alive and listening, which across an eight-hour night is
 * not the same thing at all.
 */
function rebuildFromLog(events){
  const rebuilt={ samples:[], events:[], sounds:[], pauses:[] };
  for(const ev of (events||[])){
    switch(ev.e){
      case 'sample': rebuilt.samples.push({t:ev.t, amp:ev.amp, lvl:ev.lvl}); break;
      case 'snore': rebuilt.events.push({id:'e'+rebuilt.events.length, t:ev.t, dur:ev.dur, lvl:ev.lvl, ratio:ev.pr||0, kind:'snore', clip:ev.clip||''}); break;
      case 'sound': rebuilt.sounds.push({t:ev.t, dur:ev.dur, lvl:ev.lvl, kind:ev.kind}); break;
      case 'pause': rebuilt.pauses.push({t:ev.t, dur:ev.dur, clip:ev.clip||''}); break;
    }
  }
  return rebuilt;
}

// On launch, recover a recording the UI may have missed (OS killed the WebView while the
// foreground service kept running). Reads the persisted session and either resumes the
// live UI (still recording) or finalizes an orphaned night (service already stopped).
async function reattachSession(plugin){
  if(!plugin || !plugin.getState) return false;
  let st;
  try{ st = await plugin.getState(); }catch(e){ return false; }
  if(!st || !st.events || !st.events.length) return false;

  const rebuilt = rebuildFromLog(st.events);
  const snoreN = rebuilt.events.length, pauseN = rebuilt.pauses.length;
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
    // Service stopped while the UI was gone — reconstruct and finalize so it isn't lost.
    // The log MUST be cleared afterwards: it outlives the night that produced it, so
    // without this every later cold launch recovers the same recording again and adds a
    // duplicate stamped with the launch time.
    S.samples=rebuilt.samples; S.events=rebuilt.events; S.sounds=rebuilt.sounds; S.pauses=rebuilt.pauses;
    S.startTime = st.startMs || Date.now();
    S.native=true;
    finalize(false);
    S.native=false;
    await clearNativeSession(plugin);
    switchView('report');
    toast('Recovered a recording that ended while the app was closed.');
    return true;
  }
}


/** Record that capture is alive; called on every level event. */
function noteHeartbeat(){ S._lastLevelMs = Date.now(); }

function showCaptureStalled(silentSec, serviceAlive){
  const hint=$('recHint'); if(!hint) return;
  hint.textContent = serviceAlive === false
    ? `Capture has stopped — the recording service is no longer running (silent ${silentSec}s). Tap stop and start again.`
    : `No sound has reached Nocturne for ${silentSec}s. The microphone may be blocked by another app. Tap stop and start again.`;
  hint.style.color = '#F5766A';
  S._captureStalled = true;
}

function clearCaptureStalled(){
  if(!S._captureStalled) return;
  const hint=$('recHint');
  if(hint){ hint.textContent = RECORDING_HINT; hint.style.color = ''; }
  S._captureStalled = false;
}

function startCaptureWatchdog(plugin){
  stopCaptureWatchdog();
  noteHeartbeat();
  S._watchdog = setInterval(async ()=>{
    if(!S.recording){ stopCaptureWatchdog(); return; }
    const silentMs = Date.now() - (S._lastLevelMs || 0);
    if(silentMs < HEARTBEAT_STALE_MS){ clearCaptureStalled(); return; }
    // Ask the service directly before blaming it: a stalled audio stream and a dead service
    // need different words, and the user can only act on the difference.
    let alive = null;
    if(plugin && plugin.isRunning){
      try{ alive = (await plugin.isRunning()).running; }catch(e){}
    }
    showCaptureStalled(Math.round(silentMs/1000), alive);
  }, HEARTBEAT_CHECK_MS);
}

function stopCaptureWatchdog(){
  if(S._watchdog){ clearInterval(S._watchdog); S._watchdog=0; }
  clearCaptureStalled();
}

// Re-wire native listeners to a recording already in progress (used by reattach).
async function resumeNativeListeners(plugin){
  S.recording=true; S.native=true; S.calibrating=false;
  startCaptureWatchdog(plugin);
  recBtn.classList.add('recording');
  $('haloState').textContent='Listening';
  $('recHint').textContent='Recording. You can lock the screen — Nocturne keeps listening in the background. Tap stop when you wake.';
  const add=async (name,fn)=>{ const h=await plugin.addListener(name,fn); nativeListeners.push(h); };
  await add('nocturneState', e=>{ if(e.state==='listening'){ S.calibrating=false; S.baseline=e.baseline||S.baseline; } else if(e.state==='stopped'||e.state==='auto-stopped'){ if(S.recording){ stopNative(); if(e.state==='auto-stopped') toast('Recording auto-stopped after 12 hours.'); } } });
  await add('nocturneSample', e=>{ S.samples.push({t:e.t, amp:e.amp, lvl:e.level}); });
  await add('nocturneSnore', e=>{ S.events.push({id:'e'+S.events.length, t:e.t, dur:e.dur, lvl:e.level, ratio:e.ratio||0, kind:'snore', clip:e.clip||''}); $('lsSnore').textContent=e.count; });
  await add('nocturneSound', e=>{ S.sounds.push({t:e.t, dur:e.dur, lvl:e.level, kind:e.kind}); });
  await add('nocturnePause', e=>{ S.pauses.push({t:e.t, dur:e.dur, clip:e.clip||''}); $('lsPause').textContent=e.count; });
  await add('nocturneLevel', e=>{ noteHeartbeat(); setNativeAmp((e.level||0)/100*0.2); if(e.baseline!=null) S._liveBase=e.baseline; $('levelVal').textContent=e.level; $('lsElapsed').textContent=fmtDur(e.elapsed||0); $('haloSub').textContent=e.snoring?'Snoring detected':'Breathing steady'; });
  await add('nocturneError', e=>{ toast(e.message||'Recording error'); stopRec(); });
  await add('nocturneAlarm', e=>{ toast('⏰ Smart alarm — good morning'); });
  const animate=()=>{ if(!S.recording||!S.native) return; drawHalo(nativeAmp(), $('haloSub').textContent==='Snoring detected'); dbgTick(); nativeHaloRaf=requestAnimationFrame(animate); };
  animate();
}

async function stopNative(){
  const plugin=nativePlugin();
  S.recording=false; S.native=false;
  stopCaptureWatchdog();
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
  if(wasCalibrating){
    await clearNativeSession(plugin);
    toast('Stopped during calibration — nothing recorded.');
    return;
  }

  // Reconcile against the durable log before finalizing. stop() resolves when the service is
  // scheduled to stop, not when it has finished: the last episode and any closing pause are
  // written after that, and listeners have already been removed by this point. Anything the
  // UI missed while backgrounded is also only in the log. A short wait lets that final flush
  // land before it is read.
  await new Promise(r => setTimeout(r, FINAL_FLUSH_MS));
  await reconcileWithLog(plugin);

  if(S.samples.length>5){ finalize(false); switchView('report'); }
  else toast('Night was too short to analyze. Try the sample.');
  // Clear the session now the night is saved. Without this the log outlives the night, and
  // the next cold launch takes the recovery path and finalizes the very same recording again
  // as a duplicate stamped with the launch time.
  await clearNativeSession(plugin);
}

/** Replace in-memory state with the service's log whenever the log holds more. */
async function reconcileWithLog(plugin){
  if(!plugin || !plugin.getState) return;
  try{
    const st = await plugin.getState();
    if(!st || !st.events || !st.events.length) return;
    const rebuilt = rebuildFromLog(st.events);
    if(rebuilt.samples.length < S.samples.length) return;   // keep the fuller record
    const recovered = rebuilt.events.length - S.events.length;
    S.samples=rebuilt.samples; S.events=rebuilt.events;
    S.sounds=rebuilt.sounds; S.pauses=rebuilt.pauses;
    if(st.startMs) S.startTime = st.startMs;
    if(recovered>0) toast(`Recovered ${recovered} snore${recovered===1?'':'s'} the app missed.`);
  }catch(e){ /* keep whatever the UI already has */ }
}

async function clearNativeSession(plugin){
  if(plugin && plugin.clearSession){ try{ await plugin.clearSession(); }catch(e){} }
}

export { nativePlugin, reattachSession, startNative, stopNative };
