import { removeRoomNoise } from './denoise.js';
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

// Mains hum. Anything on the grid frequency is a pump, a charger or a transformer, and it
// sits right on top of the snore: measured in one bedroom, the 50 Hz series ran to 200x the
// local noise at 50, 100, 150, 200 and 300 Hz, and it is audible as a buzz under every clip.
// The rumble cut above already removes the fundamental, but its harmonics land inside the
// snore band and survive it, so each one is notched out individually.
//
// Narrow, because mains frequency is regulated to a fraction of a hertz while a snore is
// broad — a notch this sharp takes the tone and leaves a snore harmonic sitting beside it.
// Note this is playback only. The same filtering measurably HURTS detection, because the
// classifier's periodicity and pitch evidence currently leans on that hum; nothing here
// touches the detector.
const MAINS_HZ = 50;       // set to 60 where the grid runs at 60 Hz

// The comb runs far higher than the snore band. Measured on a quiet stretch of a real night,
// the loudest surviving tone after notching only six harmonics was still 643x its neighbours,
// at 400 Hz - the eighth. Reaching to 2 kHz takes that to 20x, which is the point where what
// remains is no longer a mains harmonic at all.
const MAINS_HARMONICS = 40;

// Constant BANDWIDTH, not constant Q. Mains is regulated to a fraction of a hertz at every
// harmonic, so each tone needs the same few hertz removed. A fixed Q would widen with
// frequency until, around 1 kHz, a 40 Hz-wide notch every 50 Hz would gut the band instead of
// notching it. At 3 Hz the whole cascade costs 1.6 dB of snore while removing the buzz.
const MAINS_BANDWIDTH_HZ = 3;

// Clips arrive around -56 dBFS RMS. These bring them to about -30 dBFS with peaks near
// -14 dBFS — a ~25 dB lift measured across three real clips with zero samples clipped.
const PRE_GAIN = 26;

// The bypass needs lifting too. These recordings sit around -65 dBFS, so routing the source
// straight to the output made "original" silent rather than unfiltered - the comparison the
// toggle exists for was impossible to hear.
//
// It cannot be a fixed gain. Measured across real clips the peaks span 0.0040 to 0.0512, so
// any single value either clips the loudest or leaves the quietest inaudible. The processed
// path solves this with a compressor; the bypass deliberately has none, so instead each clip
// is lifted by its own peak. That changes level only - no filtering, which is the point.
const BYPASS_TARGET_PEAK = 0.7;
const BYPASS_GAIN_MAX = 400;
const BYPASS_GAIN_DEFAULT = 20;   // until a clip's peak is known: safe for the loudest seen
const MAKEUP_GAIN = 2.5;

let context = null;
let graph = null;

// Clips already processed, keyed by their original URL. A failed clip maps to itself, so a
// file that cannot be decoded is not retried on every play.
const prepared = new Map();

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

  const mainsCuts = [];
  for (let harmonic = 1; harmonic <= MAINS_HARMONICS; harmonic++) {
    const hz = MAINS_HZ * harmonic;
    if (hz >= ctx.sampleRate / 2 - 100) break;
    const notch = ctx.createBiquadFilter();
    notch.type = 'notch';
    notch.frequency.value = hz;
    notch.Q.value = hz / MAINS_BANDWIDTH_HZ;
    mainsCuts.push(notch);
  }

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

  const bypassGain = ctx.createGain();
  bypassGain.gain.value = BYPASS_GAIN_DEFAULT;
  source.connect(bypassGain);

  source.connect(rumbleCut);
  rumbleCut.connect(hissCut);
  // chain the mains notches between the hiss cut and the gain stage
  let tail = hissCut;
  for (const notch of mainsCuts) { tail.connect(notch); tail = notch; }
  tail.connect(preGain);
  preGain.connect(compressor);
  compressor.connect(makeup);

  return { makeup, bypass: bypassGain };
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
    // Apply what the user asked for, not an unconditional on. The graph is not built until
    // the first play, so a toggle pressed before then would otherwise be silently undone.
    setEnhanced(enhanceWanted);
    return true;
  } catch (e) {
    graph = null;
    return false;
  }
}

// What the user has asked for, held separately from the graph because the graph does not
// exist until the first playback. isEnhanced() reports this intent so the button, the clip
// source and the filter chain cannot disagree.
let enhanceWanted = true;

/** Switch between the processed chain and a clean bypass. */
function setEnhanced(on) {
  enhanceWanted = on;
  if (!graph) return;
  const { makeup, bypass, ctx } = graph;
  try { makeup.disconnect(); } catch (e) {}
  try { bypass.disconnect(ctx.destination); } catch (e) {}
  if (on) makeup.connect(ctx.destination);
  else bypass.connect(ctx.destination);
  graph.enabled = on;
}

function isEnhanced() {
  return enhanceWanted;
}

/** Browsers start contexts suspended until a user gesture; call this from the play handler. */
function resumeAudio() {
  if (context && context.state === 'suspended') context.resume().catch(() => {});
}

export { attachEnhancer, setEnhanced, isEnhanced, resumeAudio, audioContext };

/** Wrap samples as a 16-bit mono WAV so the existing <audio> element can play them. */
function encodeWav(samples, rate) {
  const bytes = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(bytes);
  const ascii = (at, text) => { for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i)); };
  ascii(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); ascii(8, 'WAVE');
  ascii(12, 'fmt '); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  ascii(36, 'data'); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, Math.round(s * 32767), true);
  }
  return new Blob([bytes], { type: 'audio/wav' });
}

/**
 * Start removing the room from a clip. Called when a clip is selected rather than when play
 * is pressed, so the work is finished by the time it is needed and play() can still be called
 * straight out of the user's gesture — awaiting first would break autoplay policy.
 */
export function prepareClip(url) {
  if (!url || prepared.has(url)) return;
  const ctx = audioContext();
  if (!ctx || !ctx.decodeAudioData) { prepared.set(url, url); return; }
  prepared.set(url, url);   // fall back to the original until the real one is ready
  fetch(url)
    .then(response => response.arrayBuffer())
    .then(bytes => ctx.decodeAudioData(bytes))
    .then(decoded => {
      const clean = removeRoomNoise(decoded.getChannelData(0));
      prepared.set(url, URL.createObjectURL(encodeWav(clean, decoded.sampleRate)));
    })
    .catch(() => { /* keep the original; a clip that will not decode still plays */ });
}

/** The processed URL if it is ready, otherwise the original. Never blocks. */
export function playableClip(url) {
  return prepared.get(url) || url;
}

/* ---------- clip envelope, for drawing a pause as a shape ---------- */

// A pause is evidence of absence, and absence is far easier to SEE than to hear: silence
// bracketed by two bursts reads instantly as a shape, where listening to it means sitting
// through the gap in real time.
const ENVELOPE_BUCKETS = 240;
const envelopes = new Map();
const peaks = new Map();

function envelopeOf(samples) {
  const out = new Float32Array(ENVELOPE_BUCKETS);
  const per = Math.max(1, Math.floor(samples.length / ENVELOPE_BUCKETS));
  for (let i = 0; i < ENVELOPE_BUCKETS; i++) {
    let peak = 0;
    const from = i * per, to = Math.min(samples.length, from + per);
    for (let j = from; j < to; j++) { const v = Math.abs(samples[j]); if (v > peak) peak = v; }
    out[i] = peak;
  }
  return out;
}

/** Peak-per-bucket envelope of a clip. Resolves null when it cannot be decoded. */
export function clipEnvelope(url) {
  if (!url) return Promise.resolve(null);
  if (envelopes.has(url)) return envelopes.get(url);
  const ctx = audioContext();
  if (!ctx || !ctx.decodeAudioData) return Promise.resolve(null);
  const pending = fetch(url)
    .then(response => response.arrayBuffer())
    .then(bytes => ctx.decodeAudioData(bytes))
    .then(decoded => {
      const env = envelopeOf(decoded.getChannelData(0));
      let peak = 0;
      for (const v of env) if (v > peak) peak = v;
      peaks.set(url, peak);
      return env;
    })
    .catch(() => null);
  envelopes.set(url, pending);
  return pending;
}

/**
 * Level the unfiltered path for one clip, so "original" is audible without clipping. Call it
 * with the RAW url; the peak comes from the same decode the envelope uses.
 */
export function tuneBypass(url) {
  if (!graph || !graph.bypass || !graph.bypass.gain) return;
  const peak = peaks.get(url);
  graph.bypass.gain.value = peak > 0
    ? Math.min(BYPASS_GAIN_MAX, BYPASS_TARGET_PEAK / peak)
    : BYPASS_GAIN_DEFAULT;
}
