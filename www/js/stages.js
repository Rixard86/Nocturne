/* ============================================================
   SLEEP STAGE ESTIMATE (acoustic proxy)
   A rough hypnogram from sound only. We bin the night into ~5-min
   blocks and infer a stage from movement (amplitude variability),
   loudness, and snoring:
     awake  = high variability / frequent loud non-snore activity
     rem    = snoring present + moderate variability (breathing irregular)
     light  = low-moderate steady activity
     deep   = very quiet & steady (low variability, low level)
   This is an approximation — sound can't measure brain state — and is
   labelled as an estimate in the UI.
   ============================================================ */
const STAGES=['awake','rem','light','deep'];
function estimateStages(samples, events, total, sounds){
  if(!samples || samples.length<3) return {hypnogram:[], pct:{awake:0,rem:0,light:0,deep:100}};
  const blockSec=300; // 5-min blocks
  const nBlocks=Math.max(1, Math.ceil(total/blockSec));
  // single-pass accumulation per block (a full night has ~23k samples)
  const acc=Array.from({length:nBlocks},()=>({sum:0,sumsq:0,n:0}));
  for(const s of samples){
    const bi=Math.min(nBlocks-1, Math.max(0, Math.floor(s.t/blockSec)));
    const L=s.lvl||0; const b=acc[bi];
    b.sum+=L; b.sumsq+=L*L; b.n++;
  }
  const snoreBlocks=new Set();
  for(const e of events){ if(e.kind==='snore') snoreBlocks.add(Math.min(nBlocks-1, Math.max(0, Math.floor(e.t/blockSec)))); }
  // movement density per block — the restlessness signal from the acoustic classifier.
  // Body movements are the strongest acoustic correlate of wake/light sleep.
  const moveCount=new Array(nBlocks).fill(0);
  (sounds||[]).forEach(sd=>{ if(sd.kind==='movement'){ const bi=Math.min(nBlocks-1,Math.max(0,Math.floor(sd.t/blockSec))); moveCount[bi]++; } });
  const hypnogram=[];
  for(let bi=0; bi<nBlocks; bi++){
    const t0=bi*blockSec, b=acc[bi];
    if(!b.n){ hypnogram.push({t:t0, stage:'light'}); continue; }
    const mean=b.sum/b.n;
    const sd=Math.sqrt(Math.max(0, b.sumsq/b.n - mean*mean));
    const hasSnore=snoreBlocks.has(bi);
    const moves=moveCount[bi];
    // Movement is the real wake/restlessness signal (from the acoustic classifier).
    // Loudness and level-variance CANNOT drive 'awake', because loud snoring inherently
    // produces both — a snoring block means the person is asleep, not awake.
    // Note: sound alone can't truly identify REM (and snoring is actually suppressed in
    // REM), so we don't force snore blocks into a specific stage — undisturbed snoring is
    // treated as ordinary (light) sleep, restless snoring as light, quiet stillness as deep.
    let stage;
    if(moves>=3 && !hasSnore){
      stage='awake';                         // frequent body movement, no snoring → awake
    } else if(hasSnore){
      stage='light';                         // snoring ⇒ asleep; count as light sleep
    } else if(moves>=1 || sd>14){
      stage='light';                         // some movement / variability → light
    } else if(mean<8 && sd<6){
      stage='deep';                          // still, quiet, steady → deep
    } else {
      stage='rem';                           // asleep, very settled, no snoring → REM-ish
    }
    hypnogram.push({t:t0, stage});
  }
  // smooth: a lone block differing from both neighbours snaps to the neighbour stage
  for(let i=1;i<hypnogram.length-1;i++){
    if(hypnogram[i-1].stage===hypnogram[i+1].stage && hypnogram[i].stage!==hypnogram[i-1].stage){
      hypnogram[i].stage=hypnogram[i-1].stage;
    }
  }
  const counts={awake:0,rem:0,light:0,deep:0};
  hypnogram.forEach(b=>counts[b.stage]++);
  const tot=hypnogram.length||1;
  const pct={};
  STAGES.forEach(s=>pct[s]=Math.round(counts[s]/tot*100));
  return {hypnogram, pct};
}

export { estimateStages };
