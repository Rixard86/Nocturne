import { finalize } from './finalize.js';
import { switchView } from './navigation.js';
import { S } from './state.js';
import { $, toast } from './ui.js';

/* ============================================================
   DEMO / SAMPLE NIGHT — synthesizes a realistic 7.5h record
   ============================================================ */
$('demoBtn').addEventListener('click',()=>{ buildSampleNight(); finalize(true); switchView('report'); toast('Sample night loaded'); });

function buildSampleNight(){
  const total=7.5*3600; // seconds
  S.samples=[]; S.events=[]; S.pauses=[]; S.recordings={}; S.sounds=[];
  S.baseline=0.012; // fixed quiet floor so demo sound levels are consistent
  const lvlOf=amp=>{ const r=Math.max(1,amp/S.baseline); return Math.max(0,Math.min(100,Math.round(Math.log2(r)/Math.log2(14)*100))); };
  let snoreCount=0;
  // Sample every 10s with STOCHASTIC loudness in snore clusters. Contiguous loud
  // minutes made every snore block's level-variance huge (all claimed by 'awake');
  // scattered loud seconds — like a real night — give block stats where REM emerges.
  for(let t=0;t<total;t+=10){
    const hr=t/3600;
    // baseline quiet with REM-period snoring clusters around 2h,4h,6h
    let amp=0.01+Math.random()*0.008;
    const inCluster = (hr>1.5&&hr<2.6)||(hr>3.6&&hr<4.8)||(hr>5.5&&hr<6.7);
    if(inCluster && Math.random()<0.14){
      amp=0.05+Math.random()*0.09;
      if(Math.random()<0.5){ // log a snore event
        S.events.push({id:'e'+S.events.length, t:t+Math.random()*10, dur:1+Math.random()*4, lvl:lvlOf(amp), kind:'snore'});
        snoreCount++;
      }
    }
    S.samples.push({t, amp, lvl:lvlOf(amp)});
  }
  // seed apnea-pattern pauses inside clusters: loud snore then long gap
  [2.05,2.3,4.1,4.45,6.0,6.25].forEach(hr=>{
    if(Math.random()<0.8) S.pauses.push({t:hr*3600, dur:10+Math.random()*14});
  });
  S.events.sort((a,b)=>a.t-b.t);
  S.pauses.sort((a,b)=>a.t-b.t);
  // seed a realistic scatter of movement/other sounds so staging + breakdown show
  S.sounds=[];
  const nMoves=18+Math.floor(Math.random()*14);
  for(let i=0;i<nMoves;i++){
    S.sounds.push({t:Math.random()*total, dur:0.5+Math.random()*2, lvl:20+Math.round(Math.random()*40), kind:'movement'});
  }
  const nOther=6+Math.floor(Math.random()*8);
  for(let i=0;i<nOther;i++){
    S.sounds.push({t:Math.random()*total, dur:0.5+Math.random()*3, lvl:15+Math.round(Math.random()*35), kind:'other'});
  }
  S.sounds.sort((a,b)=>a.t-b.t);
  S._demoTotal=total;
}

