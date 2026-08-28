import { S, SENSITIVITY } from './state.js';

/* ---------- persistent storage ----------
   Nights are saved to Capacitor Preferences on device (survives app restarts),
   falling back to localStorage on the web. History is loaded once at startup. */
const STORE_KEY='nocturne.history.v1';
const SETTINGS_KEY='nocturne.settings.v1';
function prefsPlugin(){
  const C=window.Capacitor;
  if(C && C.Plugins && C.Plugins.Preferences) return C.Plugins.Preferences;
  return null;
}
// persist user settings (alarm + sensitivity) so they survive app restarts
async function saveSettings(){
  try{
    const raw=JSON.stringify({ sensitivity:S.sensitivity, alarm:S.alarm, askedBattery:!!S._askedBattery });
    const P=prefsPlugin();
    if(P){ await P.set({key:SETTINGS_KEY, value:raw}); }
    else { localStorage.setItem(SETTINGS_KEY, raw); }
  }catch(e){}
}
async function loadSettings(){
  try{
    const P=prefsPlugin();
    let raw=null;
    if(P){ const r=await P.get({key:SETTINGS_KEY}); raw=r&&r.value; }
    else { raw=localStorage.getItem(SETTINGS_KEY); }
    if(raw){
      const s=JSON.parse(raw);
      if(s.sensitivity && SENSITIVITY[s.sensitivity]) S.sensitivity=s.sensitivity;
      if(s.alarm && typeof s.alarm==='object') S.alarm={...S.alarm, ...s.alarm};
      if(s.askedBattery) S._askedBattery=true;
    }
  }catch(e){}
}
async function loadHistory(){
  try{
    const P=prefsPlugin();
    let raw=null;
    if(P){ const r=await P.get({key:STORE_KEY}); raw=r&&r.value; }
    else { raw=localStorage.getItem(STORE_KEY); }
    if(raw){
      const arr=JSON.parse(raw);
      // revive Date objects
      arr.forEach(n=>{ if(typeof n.date==='string') n.date=new Date(n.date); });
      S.history=arr;
    }
  }catch(e){ /* start empty on any parse/storage error */ }
  return S.history;
}
async function saveHistory(){
  try{
    // strip the huge raw per-sample array, but keep a DOWNSAMPLED timeline (~800 buckets)
    // and the hypnogram so a past night's report can still render its charts on reopen.
    const slim=S.history.map(n=>{
      const {samples, sounds, ...rest}=n;
      if(!rest.timelineMini && Array.isArray(samples) && samples.length){
        rest.timelineMini = downsampleTimeline(samples, n.durationSec||1, 800);
      }
      return rest; // hypnogram is small; keep it as-is
    });
    const raw=JSON.stringify(slim);
    const P=prefsPlugin();
    if(P){ await P.set({key:STORE_KEY, value:raw}); }
    else { localStorage.setItem(STORE_KEY, raw); }
  }catch(e){ /* non-fatal */ }
}
// Reduce raw samples to a compact [ {t, amp} ] array of at most `buckets` points
// (max amplitude per bucket) — a few KB, enough to redraw the timeline waveform.
function downsampleTimeline(samples, total, buckets){
  const agg=new Array(buckets).fill(0);
  for(const s of samples){
    const bi=Math.min(buckets-1, Math.max(0, Math.floor((s.t/total)*buckets)));
    if(s.amp>agg[bi]) agg[bi]=s.amp;
  }
  const out=[];
  for(let i=0;i<buckets;i++){ if(agg[i]>0) out.push({t:(i/buckets)*total, amp:Math.round(agg[i]*10000)/10000}); }
  return out;
}
async function clearHistory(){
  S.history=[];
  try{
    const P=prefsPlugin();
    if(P){ await P.remove({key:STORE_KEY}); }
    else { localStorage.removeItem(STORE_KEY); }
  }catch(e){}
}

export { clearHistory, loadHistory, loadSettings, saveHistory, saveSettings };
