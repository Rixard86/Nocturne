/* ============================================================
   SNORE PLAYBACK ENHANCEMENT

   Measured on real clips from this app: peak sits around -40 dBFS with ~40 dB of unused
   headroom, and 15-49% of the energy is below 80 Hz — structure-borne rumble from the
   phone lying on a mattress. There is almost nothing above 1.5 kHz (0.1-3%), so
   "denoising" is not the useful lever; removing the rumble and lifting the level is.

   A harmonic exciter was tried here first, on the theory that a phone speaker rolls off
   below ~400 Hz and a 100-170 Hz snore is only heard through its overtones. Measured, it
   made things WORSE at every listenable setting — the band-passed fundamental dominates
   the shaper's output, so it pushed energy back into 80-300 Hz rather than above it:

       no exciter  ->  10.0% of energy in the 300 Hz-4 kHz speaker-audible band
       drive 1.5   ->   7.3%
       drive 3     ->   5.2%
       (original)  ->   8.0%

   Only an absurd drive shifted the balance, and that buried the snore under a square
   wave. So the chain is deliberately plain: cut the rumble, trim the little hiss, even
   out the breath envelope, and make up the gain — no distortion of any kind.
   ============================================================ */

const RUMBLE_HZ = 70;      // below this is inaudible on a phone and only wastes headroom
const HISS_HZ = 4000;      // little content above this; trims what noise there is

// Clips arrive around -56 dBFS RMS. These bring them to about -30 dBFS with peaks near
// -14 dBFS — a ~25 dB lift measured across three real clips with zero samples clipped.
const PRE_GAIN = 26;
const MAKEUP_GAIN = 2.5;

let context = null;
let graph = null;

/** One shared context for the whole session — a per-playback context leaks, and browsers
 *  cap concurrent contexts at around six, after which playback fails outright. */
function audioContext() {
  if (context) return context;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return null;
  context = new Ctor();
  return context;
}

function buildGraph(source, ctx) {
  const rumbleCut = ctx.createBiquadFilter();
  rumbleCut.type = 'highpass';
  rumbleCut.frequency.value = RUMBLE_HZ;

  const hissCut = ctx.createBiquadFilter();
  hissCut.type = 'lowpass';
  hissCut.frequency.value = HISS_HZ;

  const preGain = ctx.createGain();
  preGain.gain.value = PRE_GAIN;

  // Even out the breath envelope so quiet inhalations are not lost under loud ones, and
  // hold the loudest breaths well below clipping.
  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = -32;
  compressor.knee.value = 20;
  compressor.ratio.value = 4;
  compressor.attack.value = 0.006;
  compressor.release.value = 0.18;

  const makeup = ctx.createGain();
  makeup.gain.value = MAKEUP_GAIN;

  source.connect(rumbleCut);
  rumbleCut.connect(hissCut);
  hissCut.connect(preGain);
  preGain.connect(compressor);
  compressor.connect(makeup);

  return { makeup, bypass: source };
}

/**
 * Route an audio element through the enhancement chain. Safe to call repeatedly; the
 * element can only ever be attached to one source node, so the graph is built once.
 * Returns false when Web Audio is unavailable, so the caller can fall back to plain
 * playback rather than losing sound entirely.
 */
function attachEnhancer(el) {
  if (graph) return true;
  const ctx = audioContext();
  if (!ctx || !ctx.createMediaElementSource) return false;
  try {
    const source = ctx.createMediaElementSource(el);
    graph = buildGraph(source, ctx);
    graph.ctx = ctx;
    graph.enabled = false;
    setEnhanced(true);
    return true;
  } catch (e) {
    graph = null;
    return false;
  }
}

/** Switch between the processed chain and a clean bypass. */
function setEnhanced(on) {
  if (!graph) return;
  const { makeup, bypass, ctx } = graph;
  try { makeup.disconnect(); } catch (e) {}
  try { bypass.disconnect(ctx.destination); } catch (e) {}
  if (on) makeup.connect(ctx.destination);
  else bypass.connect(ctx.destination);
  graph.enabled = on;
}

function isEnhanced() {
  return !!(graph && graph.enabled);
}

/** Browsers start contexts suspended until a user gesture; call this from the play handler. */
function resumeAudio() {
  if (context && context.state === 'suspended') context.resume().catch(() => {});
}

export { attachEnhancer, setEnhanced, isEnhanced, resumeAudio, audioContext };
