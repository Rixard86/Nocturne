import { renderReport } from './report.js';
import { estimateStages } from './stages.js';
import { S, snoreRatio } from './state.js';
import { saveHistory } from './storage.js';
import { renderTrends } from './trends.js';
import { band } from './ui.js';

/* ============================================================
   FINALIZE — compute score & build the night object
   ============================================================ */
function finalize(isDemo){
  // flush a snore episode still open at stop time (web path) so it isn't lost
  if(!isDemo && S.snoreEp){
    const dur=(S.snoreEp.lastActive - S.snoreEp.start)/1000;
    if(dur>0.35 && S.snoreEp.peak>=20){
      S.events.push({id:'e'+S.events.length, t:(S.snoreEp.start-S.startTime)/1000, dur, lvl:S.snoreEp.peak, kind:'snore'});
    }
    S.snoreEp=null;
  }
  // flush a silence-pause still open at stop time (web path)
  if(!isDemo && S.silentSince){
    const gap=(Date.now()-S.silentSince)/1000;
    const sinceEp=S.lastEpLoud? (S.silentSince - S.lastEpLoud)/1000 : Infinity;
    if(gap>=9 && gap<=60 && S.lastEpDur>=2 && sinceEp>=-2 && sinceEp<=20){
      S.pauses.push({t:(S.silentSince-S.startTime)/1000, dur:gap});
    }
    S.silentSince=0;
  }
  const total = isDemo? S._demoTotal : (S.samples.length? S.samples[S.samples.length-1].t : 0);
  // Classify loud samples by their stored LEVEL, which was computed against the live
  // baseline at capture time. (Filtering by raw amp against S.baseline broke on the
  // native path, where the detector's baseline adapts all night while JS kept the
  // stale calibration value — producing 0% snoring despite hundreds of events.)
  const ratio = isDemo? 2.0 : snoreRatio();
  const loudLvl = Math.max(6, Math.round(Math.log2(ratio)/Math.log2(14)*100));
  const loudSamples = S.samples.filter(s=>(s.lvl||0) >= loudLvl);
  const nSamples = S.samples.length || 1;
  // Each sample is one equal time-slice (live=1s, demo=60s), so the fraction of loud
  // samples IS the fraction of the night spent snoring — no per-sample-seconds needed.
  const snorePct = Math.min(100, Math.round((loudSamples.length / nSamples) * 100));
  const avgLoudLvl = loudSamples.length? loudSamples.reduce((a,s)=>a+(s.lvl||0),0)/loudSamples.length : 0;

  // Snore Score 0-100: blends how much of the night + how loud (relative level) + pause
  // penalty (capped so a miscount can never single-handedly peg the score at 100)
  let score = Math.min(100,
      snorePct*0.6 +
      avgLoudLvl*0.35 +
      Math.min(S.pauses.length,20)*2.5);
  score=Math.max(0,Math.round(score));

  // breathing-stability index (BreathFlow-style): % of night in steady breathing.
  // Unstable = fraction of loud samples plus the share of the night lost to pauses.
  const pauseSec = S.pauses.reduce((a,p)=>a+p.dur,0);
  const unstableFrac = (loudSamples.length / nSamples) + (total? pauseSec/total : 0);
  const stablePct = Math.max(0, Math.min(100, Math.round(100 - unstableFrac*100)));

  // sleep-stage estimate (acoustic proxy)
  const stages = estimateStages(S.samples, S.events, total, S.sounds);

  const night={
    date:new Date(),
    score, band:band(score).name,
    durationSec:total,
    snorePct:Math.round(snorePct),
    snoreEvents:S.events.length,
    pauses:S.pauses.length,
    pauseLongest: S.pauses.reduce((m,p)=>Math.max(m,p.dur),0),
    avgLvl:Math.round(avgLoudLvl)||0,
    peakLvl: S.samples.reduce((m,s)=>Math.max(m,s.lvl||0),0),
    stablePct:Math.round(stablePct),
    stages:stages.pct,
    hypnogram:stages.hypnogram,
    samples:S.samples.slice(),
    events:S.events.slice(),
    pauseList:S.pauses.slice(),
    sounds:S.sounds.slice(),
    movementCount:S.sounds.filter(s=>s.kind==='movement').length,
    otherCount:S.sounds.filter(s=>s.kind==='other').length,
    factors:[], remedies:[],
    isDemo
  };
  S.current=night;
  S.history.unshift(night);
  if(S.history.length>60) S.history.pop();
  if(!isDemo) saveHistory();   // persist real nights across restarts
  renderReport();
  renderTrends();
}

export { finalize };
