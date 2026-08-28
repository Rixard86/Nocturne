import { drawTimelineLive } from './charts.js';
import { finalize } from './finalize.js';
import { drawHalo, resetHalo } from './halo.js';
import { nativePlugin, startNative, stopNative } from './native-bridge.js';
import { switchView } from './navigation.js';
import { CALIBRATION_MS, S, snoreRatio, soundLevel } from './state.js';
import { $, fmtDur, toast } from './ui.js';

/* ============================================================
   LIVE RECORDING — Web Audio API
   ============================================================ */
const recBtn=$('recBtn');
recBtn.addEventListener('click',()=> S.recording? stopRec() : startRec());

async function ensureMicPermission(){
  // On native Android (Capacitor) the WebView still needs the runtime permission granted.
  // The Microphone plugin, if present, surfaces the OS dialog. On the web this is a no-op.
  try{
    const Cap = window.Capacitor;
    if(Cap && Cap.isNativePlatform && Cap.isNativePlatform()){
      const Mic = Cap.Plugins && Cap.Plugins.Microphone;
      if(Mic && Mic.requestPermissions){
        const res = await Mic.requestPermissions();
        const st = res && (res.microphone || res.recordAudio || res.state);
        if(st && st !== 'granted') return false;
      }
    }
  }catch(e){ /* fall through to getUserMedia, which will prompt or fail */ }
  return true;
}

async function startRec(){
  const plugin=nativePlugin();
  if(plugin){
    // The native service only CHECKS the permission and rejects without it, so the OS
    // dialog has to be raised here first — otherwise a fresh install records nothing and
    // the user is told to go find the Settings page unaided.
    const granted = await ensureMicPermission();
    if(!granted){ toast('Microphone permission denied. Enable it in Settings, or use the sample night.'); return; }
    await startNative(plugin);
    return;
  }
  // ---- web fallback (WebAudio) ----
  const ok = await ensureMicPermission();
  if(!ok){ toast('Microphone permission denied. Enable it in Settings, or use the sample night.'); return; }
  try{
    S.micStream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false}});
  }catch(e){
    toast('Microphone access is needed to listen. Try the sample night.');
    return;
  }
  S.audioCtx=new (window.AudioContext||window.webkitAudioContext)();
  const src=S.audioCtx.createMediaStreamSource(S.micStream);
  S.analyser=S.audioCtx.createAnalyser();
  S.analyser.fftSize=2048; S.analyser.smoothingTimeConstant=0.7;
  src.connect(S.analyser);

  S.recording=true; S.startTime=Date.now();
  S.samples=[]; S.events=[]; S.pauses=[]; S.recordings={}; S.sounds=[];
  S.inSnore=false; S.quietSince=0; S.loudSince=0; S.snoreEp=null; S.silentSince=0; S.lastEpLoud=0; S.lastEpDur=0;
  // Begin with a short ambient measurement so detection adapts to this room/device.
  S.calibrating=true; S.calibStart=Date.now(); S.calibSamples=[];
  recBtn.classList.add('recording');
  $('haloState').textContent='Calibrating';
  $('haloSub').textContent='Measuring the room…';
  $('recHint').textContent='Hold still and quiet for a few seconds while Nocturne learns the room. Detection starts automatically.';
  loop();
}

function stopRec(){
  if(S.native){ stopNative(); return; }
  const wasCalibrating=S.calibrating;
  S.recording=false; S.calibrating=false;
  recBtn.classList.remove('recording');
  cancelAnimationFrame(S.raf);
  resetHalo();
  if(S.micStream) S.micStream.getTracks().forEach(t=>t.stop());
  if(S.audioCtx) S.audioCtx.close();
  $('haloState').textContent='Idle';
  $('levelVal').textContent='—';
  $('haloSub').textContent='Tap record to begin';
  $('recHint').textContent="Place your phone face-down on the mattress or nightstand, within arm's reach. Keep it plugged in.";
  if(wasCalibrating){ toast('Stopped during calibration — nothing recorded.'); return; }
  if(S.samples.length>20){ finalize(false); switchView('report'); }
  else toast('Night was too short to analyze. Try the sample.');
}

const buf=new Uint8Array(1024);
function rms(){
  S.analyser.getByteTimeDomainData(buf);
  let sum=0;
  for(let i=0;i<buf.length;i++){const v=(buf[i]-128)/128;sum+=v*v;}
  return Math.sqrt(sum/buf.length);
}

function loop(){
  if(!S.recording) return;
  const now=Date.now(), amp=rms();
  const elapsed=(now-S.startTime)/1000;

  // ---------- CALIBRATION PHASE ----------
  if(S.calibrating){
    S.calibSamples.push(amp);
    const left=Math.max(0, CALIBRATION_MS-(now-S.calibStart));
    $('levelVal').textContent=Math.ceil(left/1000);
    $('haloSub').textContent='Measuring the room…';
    drawHalo(amp, false);
    if(now-S.calibStart>=CALIBRATION_MS){
      // set the room baseline from the median of the quiet samples (robust to a stray noise)
      const sorted=S.calibSamples.slice().sort((a,b)=>a-b);
      const med=sorted[Math.floor(sorted.length/2)]||0.012;
      S.baseline=Math.max(0.004, med);   // floor so a dead-silent mic doesn't over-sensitize
      S.calibrating=false;
      S.quietSince=now;
      $('haloState').textContent='Listening';
      $('recHint').textContent='Recording. Leave the screen on or locked — analysis continues. Tap stop when you wake.';
    }
    S.raf=requestAnimationFrame(loop);
    return;
  }

  // ---------- DETECTION PHASE ----------
  // adaptive baseline keeps following the quiet floor slowly (drift, AC turning on, etc.)
  if(amp < S.baseline*1.4) S.baseline = S.baseline*0.995 + amp*0.005;
  const ratio = amp/(S.baseline||0.01);
  const lvl = soundLevel(amp);
  const SNORE_RATIO = snoreRatio();

  // store a downsampled sample every ~1s
  if(!S._lastSamp || now-S._lastSamp>1000){
    S.samples.push({t:elapsed, amp, lvl});
    S._lastSamp=now;
    drawTimelineLive();
  }

  // snore detection with continuity merging: a run of snoring breaths separated by
  // only short gaps is treated as ONE episode. We keep an open episode alive across
  // gaps up to SNORE_MERGE_GAP, extending it when snoring resumes, and only finalize
  // it once the quiet persists beyond that window.
  const SNORE_MERGE_GAP = 4000; // ms of quiet allowed inside one continuous episode
  const MIN_EP_PEAK = 20;       // must at some point reach ~2x the room floor to be a snore
  if(ratio>SNORE_RATIO){
    if(!S.snoreEp){
      // start a new episode
      S.snoreEp = { start:now, lastActive:now, peak:lvl };
    } else {
      S.snoreEp.lastActive = now;
      if(lvl > S.snoreEp.peak) S.snoreEp.peak = lvl;
    }
  }
  // finalize an open episode only after the merge gap of continuous quiet
  if(S.snoreEp && (now - S.snoreEp.lastActive) >= SNORE_MERGE_GAP){
    const dur=(S.snoreEp.lastActive - S.snoreEp.start)/1000;
    if(dur>0.35 && S.snoreEp.peak>=MIN_EP_PEAK){ // real snore, not a breath blip
      const id='e'+S.events.length;
      S.events.push({id, t:(S.snoreEp.start-S.startTime)/1000, dur, lvl:S.snoreEp.peak, kind:'snore'});
      $('lsSnore').textContent=S.events.length;
      // remember this episode as apnea context for pause detection
      S.lastEpLoud=S.snoreEp.lastActive; S.lastEpDur=dur;
    }
    S.snoreEp=null;
  }
  // environment-change guard: continuously loud for minutes = a fan/AC turning on,
  // not snoring (snoring always has inter-breath gaps). Rebase the floor and discard,
  // so the frozen-baseline problem can't kill detection for the rest of the night.
  if(S.snoreEp && (now - S.snoreEp.start) > 120000){
    S.baseline = Math.max(S.baseline, amp*0.8);
    S.snoreEp = null;
  }

  // breathing-pause / apnea-pattern flag — rewritten to match real apnea acoustics:
  // near-TOTAL silence (well below breathing sounds), lasting 9-60s, that follows a
  // genuine snore episode (>=2s) — measured when sound RESUMES so durations are real.
  // Quiet breathing sits above the silence floor, so it no longer looks like a pause.
  const isSilent = amp < S.baseline*1.2;
  if(isSilent){
    if(!S.silentSince) S.silentSince=now;
  } else {
    if(S.silentSince){
      const gap=(now-S.silentSince)/1000;
      const sinceEp=S.lastEpLoud? (S.silentSince - S.lastEpLoud)/1000 : Infinity;
      if(gap>=9 && gap<=60 && S.lastEpDur>=2 && sinceEp>=-2 && sinceEp<=20){
        S.pauses.push({t:(S.silentSince-S.startTime)/1000, dur:gap});
        $('lsPause').textContent=S.pauses.length;
      }
      S.silentSince=0;
    }
  }

  // UI
  $('levelVal').textContent=lvl;
  $('lsElapsed').textContent=fmtDur(elapsed);
  if(ratio>SNORE_RATIO) $('haloSub').textContent='Snoring detected';
  else if(S.silentSince && (now-S.silentSince)/1000>9 && S.lastEpDur>=2) $('haloSub').textContent='Extended silence — possible pause';
  else $('haloSub').textContent='Breathing steady';

  drawHalo(amp, ratio>SNORE_RATIO);
  S.raf=requestAnimationFrame(loop);
}

export { recBtn, stopRec };
