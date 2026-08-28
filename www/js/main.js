import { drawHypnogram, drawTimelineReport } from './charts.js';
import { wireDebugToggle } from './debug.js';
// Side-effect only: wires the sample-night button. Exports nothing, so it must be
// imported explicitly or it drops out of the module graph entirely.
import './demo.js';
import { idleHalo, sizeHalo } from './halo.js';
import { buildChips } from './log.js';
import { nativePlugin, reattachSession } from './native-bridge.js';
import { S, SENSITIVITY } from './state.js';
import { loadHistory, loadSettings, saveSettings } from './storage.js';
import { renderTrends } from './trends.js';
import { $, toast } from './ui.js';

/* ---------- init ---------- */
function bindSensitivity(){
  const seg=$('sensSeg');
  if(!seg) return;
  seg.querySelectorAll('button').forEach(b=>b.onclick=()=>{
    S.sensitivity=b.dataset.sens;
    seg.querySelectorAll('button').forEach(x=>x.classList.toggle('on',x===b));
    const lab=(SENSITIVITY[S.sensitivity]||SENSITIVITY.auto).label;
    const sl=$('sensLabel'); if(sl) sl.textContent='Detection · '+lab;
    // push to the native detector immediately if a native recording is active
    const plugin=nativePlugin();
    if(plugin && S.native){ try{ plugin.setSensitivity({ ratio:(SENSITIVITY[S.sensitivity]||SENSITIVITY.auto).ratio }); }catch(e){} }
    // takes effect immediately, even mid-recording (detection reads snoreRatio() live)
    toast('Detection: '+lab);
    saveSettings();
  });
  // Detection is Auto by default; the manual override stays hidden. Triple-tap the
  // "Detection" label to reveal the Auto/Low/Med/High control.
  const sl=$('sensLabel');
  if(sl){ let taps=0,last=0; sl.addEventListener('click',()=>{
    const t=Date.now(); taps=(t-last<1500)?taps+1:1; last=t;
    if(taps>=3){ taps=0; seg.style.display=(seg.style.display==='none'?'inline-flex':'none'); }
  }); }
}

function renderAlarmStatus(){
  const el=$('alarmStatus'); if(!el) return;
  if(S.alarm.on){
    el.innerHTML=`<span class="big">${S.alarm.time}</span>Smart wake within ${S.alarm.windowMin} min before`;
  } else {
    el.innerHTML='Smart alarm is off';
  }
}
function bindAlarm(){
  const t=$('alarmToggle'), body=$('alarmBody'), time=$('alarmTime'), win=$('alarmWin');
  if(!t) return;
  // reflect current state into controls
  t.checked=S.alarm.on; body.style.display=S.alarm.on?'flex':'none';
  if(time) time.value=S.alarm.time;
  t.onchange=()=>{ S.alarm.on=t.checked; body.style.display=t.checked?'flex':'none'; renderAlarmStatus(); saveSettings(); };
  if(time) time.onchange=()=>{ S.alarm.time=time.value||'07:00'; renderAlarmStatus(); saveSettings(); };
  if(win) win.querySelectorAll('button').forEach(b=>b.onclick=()=>{
    S.alarm.windowMin=parseInt(b.dataset.win,10)||30;
    win.querySelectorAll('button').forEach(x=>x.classList.toggle('on',x===b));
    renderAlarmStatus(); saveSettings();
  });
  renderAlarmStatus();
}

function init(){
  wireDebugToggle();
  // load saved settings first so the controls render with the user's choices
  loadSettings().then(()=>{
    sizeHalo(); idleHalo(); buildChips(); bindSensitivity(); bindAlarm();
    // reflect loaded sensitivity into the segmented control + label
    const seg=$('sensSeg');
    if(seg) seg.querySelectorAll('button').forEach(x=>x.classList.toggle('on', x.dataset.sens===S.sensitivity));
    const sl=$('sensLabel'); if(sl) sl.textContent='Detection · '+((SENSITIVITY[S.sensitivity]||SENSITIVITY.auto).label);
  });
  window.addEventListener('resize',()=>{sizeHalo(); if(S.current&&$('tl'))drawTimelineReport(); if(S.current&&$('hypno'))drawHypnogram(); if($('trend'))renderTrends();});
  // load saved nights so Trends & history persist across app restarts, THEN recover any
  // in-progress / orphaned recording — sequenced so a recovered night that finalize()
  // adds to history can't be clobbered by loadHistory's later assignment.
  loadHistory().then(()=>{
    if($('view-trends').classList.contains('active')) renderTrends();
    const plugin=nativePlugin();
    if(plugin){
      requestNotificationPermission(plugin);
      reattachSession(plugin).catch(()=>{});
    }
  });
}
init();

// Android 13+ needs POST_NOTIFICATIONS granted at runtime or the foreground-service and
// smart-alarm notifications silently won't show. Ask once, quietly.
async function requestNotificationPermission(plugin){
  try{
    const LN = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.LocalNotifications;
    if(LN && LN.checkPermissions && LN.requestPermissions){
      const st = await LN.checkPermissions();
      if(st && st.display!=='granted'){ await LN.requestPermissions(); }
    }
  }catch(e){}
}

