/* ============================================================
   NOCTURNE — on-device snore & breathing-pause analysis
   Models the shared core of SnoreLab / Sleep Cycle / SnoreClock:
   mic detection, intensity score, night timeline + event playback,
   apnea-pattern (pause) flagging, lifestyle/remedy logging, trends.
   ============================================================ */

const S = {
  recording:false, audioCtx:null, analyser:null, micStream:null, raf:null,
  startTime:0, samples:[], events:[], pauses:[],
  lastSnoreMark:0, inSnore:false, snoreStart:0, quietSince:0, loudSince:0,
  baseline:0.012, history:[], current:null,
  recordings:{}, // event audio buffers keyed by event id (live mode)
  playingEl:null,
  native:false,           // true while the Android native service is capturing
  snoreEp:null,           // open continuous-snore episode being merged {start,lastActive,peak}
  sounds:[],              // classified movement/other sounds for sleep staging
  alarm:{ on:false, time:'07:00', windowMin:30 },
  // --- calibration & sensitivity ---
  sensitivity:'auto',     // 'auto' (default, classifier-driven) | 'low' | 'med' | 'high'
  calibrating:false,      // true during the initial room-baseline measurement
  calibStart:0,           // when calibration began
  calibSamples:[],        // ambient RMS values collected during calibration
};

// How long we listen to the quiet room before detection begins (ms).
const CALIBRATION_MS = 4000;

// Detection defaults to Auto: a single low wake-gate opens an episode and the acoustic
// classifier (pitch / periodicity / two-peak / steady-noise, plus per-user F0) makes the
// real snore/not-snore call. The gate is deliberately low so faint snores still reach the
// classifier; the episode-peak gate (minEpisodePeak, native) is the effective loudness
// floor. Manual Low/Med/High stay as a hidden override (triple-tap the Detection label).
const SENSITIVITY = {
  auto: { ratio:1.4, label:'Auto' },
  low:  { ratio:2.8, label:'Low'  },
  med:  { ratio:2.0, label:'Medium' },
  high: { ratio:1.5, label:'High' }
};
function snoreRatio(){ return (SENSITIVITY[S.sensitivity]||SENSITIVITY.auto).ratio; }

// Relative "sound level" 0-100, anchored to the room baseline so it behaves
// consistently across devices. This is NOT calibrated dB SPL — it's how far a
// sound rises above the measured quiet floor, log-scaled for a natural feel.
function soundLevel(amp){
  const b = S.baseline || 0.01;
  const ratio = Math.max(1, amp / b);
  // log scale: ratio 1 -> 0, ~2x -> ~30, ~5x -> ~65, ~12x+ -> ~100
  const lvl = Math.log2(ratio) / Math.log2(14) * 100;
  return Math.max(0, Math.min(100, Math.round(lvl)));
}

export { CALIBRATION_MS, S, SENSITIVITY, snoreRatio, soundLevel };
