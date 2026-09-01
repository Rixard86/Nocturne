/* ============================================================
   STATIONARY NOISE REMOVAL FOR SNORE CLIPS

   A bedroom is rarely quiet. Measured in one, the recordings carry a 50 Hz mains comb from
   aquarium pumps reaching past 3 kHz, plus a broad hiss floor. Playback lifts everything by
   ~26 dB, which makes all of it clearly audible between breaths.

   Notch filters were tried first and are not enough: they remove tones, and much of what you
   hear is broadband. Measured on real clips, forty notches left the gaps at -63 dBFS while
   this leaves them at -90.

   The room is stationary and a snore is not, so the room can be measured and removed. The
   quietest quarter of the clip's own frames gives its noise spectrum — no calibration step
   and no assumption about what is in the room — and that spectrum is subtracted from every
   frame, keeping the original phase.

   Subtracting hard produces "musical noise", a warbling underwater texture, because isolated
   spectral bins survive at random. Smoothing the gain across frequency and time removes it:
   the gain then varies gently rather than flickering bin to bin. Judged by ear, the smoothed
   settings sound clean where the unsmoothed ones warble, and the snore survives it.
   ============================================================ */

const FRAME = 1024;              // ~116 ms at 8.8 kHz: long enough to resolve a 50 Hz comb
const HOP = FRAME / 4;           // 75% overlap, so the smoothed gain moves smoothly
const NOISE_PERCENTILE = 0.25;   // quietest quarter of frames is taken to be the room
const OVER_SUBTRACT = 3.0;       // how much of the measured room to remove
const SPECTRAL_FLOOR = 0.04;     // never take a bin fully to zero; silence sounds unnatural
const SMOOTH_BINS = 7;           // gain smoothing across frequency
const SMOOTH_TIME = 0.6;         // gain smoothing across frames, 0 = none

/** In-place radix-2 FFT. Length must be a power of two. */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k], ai = im[i + k];
        const br = re[i + k + len / 2], bi = im[i + k + len / 2];
        const tr = br * cr - bi * ci, ti = br * ci + bi * cr;
        re[i + k] = ar + tr; im[i + k] = ai + ti;
        re[i + k + len / 2] = ar - tr; im[i + k + len / 2] = ai - ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

/** Inverse FFT via conjugation, so only one transform needs implementing. */
function ifft(re, im) {
  for (let i = 0; i < im.length; i++) im[i] = -im[i];
  fft(re, im);
  const n = re.length;
  for (let i = 0; i < n; i++) { re[i] /= n; im[i] = -im[i] / n; }
}

function hann(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}

/** Median of a copy, used to characterise the room without letting one loud frame skew it. */
function median(values) {
  const sorted = Float64Array.from(values).sort();
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Remove the clip's own stationary background. Returns a new Float32Array; the input is not
 * modified. Clips shorter than a few frames are returned unchanged, since there is not enough
 * material to measure a noise floor from.
 */
export function removeRoomNoise(samples) {
  const n = samples.length;
  const frameCount = Math.floor((n - FRAME) / HOP) + 1;
  if (frameCount < 8) return Float32Array.from(samples);

  const win = hann(FRAME);
  const bins = FRAME / 2 + 1;
  const mag = new Float64Array(frameCount * bins);
  const phaseRe = new Float64Array(frameCount * bins);
  const phaseIm = new Float64Array(frameCount * bins);
  const energy = new Float64Array(frameCount);

  const re = new Float64Array(FRAME);
  const im = new Float64Array(FRAME);
  for (let f = 0; f < frameCount; f++) {
    const start = f * HOP;
    for (let i = 0; i < FRAME; i++) { re[i] = samples[start + i] * win[i]; im[i] = 0; }
    fft(re, im);
    let sum = 0;
    for (let k = 0; k < bins; k++) {
      const m = Math.hypot(re[k], im[k]);
      mag[f * bins + k] = m;
      phaseRe[f * bins + k] = re[k];
      phaseIm[f * bins + k] = im[k];
      sum += m;
    }
    energy[f] = sum;
  }

  // the room: median magnitude per bin over the quietest frames
  const order = Array.from({ length: frameCount }, (_, i) => i).sort((a, b) => energy[a] - energy[b]);
  const quietCount = Math.max(3, Math.round(frameCount * NOISE_PERCENTILE));
  const noise = new Float64Array(bins);
  const column = new Float64Array(quietCount);
  for (let k = 0; k < bins; k++) {
    for (let q = 0; q < quietCount; q++) column[q] = mag[order[q] * bins + k];
    noise[k] = median(column);
  }

  // gain per bin, then smoothed so it cannot flicker and produce musical noise
  const gain = new Float64Array(frameCount * bins);
  for (let f = 0; f < frameCount; f++) {
    for (let k = 0; k < bins; k++) {
      const m = mag[f * bins + k];
      const kept = Math.max(m - OVER_SUBTRACT * noise[k], SPECTRAL_FLOOR * m);
      gain[f * bins + k] = m > 1e-12 ? kept / m : 1;
    }
  }
  if (SMOOTH_BINS > 1) {
    const half = SMOOTH_BINS >> 1;
    const row = new Float64Array(bins);
    for (let f = 0; f < frameCount; f++) {
      row.set(gain.subarray(f * bins, f * bins + bins));
      for (let k = 0; k < bins; k++) {
        let sum = 0, count = 0;
        for (let j = Math.max(0, k - half); j <= Math.min(bins - 1, k + half); j++) { sum += row[j]; count++; }
        gain[f * bins + k] = sum / count;
      }
    }
  }
  for (let f = 1; f < frameCount; f++) {
    for (let k = 0; k < bins; k++) {
      const i = f * bins + k;
      gain[i] = SMOOTH_TIME * gain[i - bins] + (1 - SMOOTH_TIME) * gain[i];
    }
  }

  // overlap-add back to a waveform, dividing out the squared window
  const out = new Float64Array(n);
  const weight = new Float64Array(n);
  for (let f = 0; f < frameCount; f++) {
    for (let k = 0; k < bins; k++) {
      const g = gain[f * bins + k];
      re[k] = phaseRe[f * bins + k] * g;
      im[k] = phaseIm[f * bins + k] * g;
      if (k > 0 && k < FRAME / 2) { re[FRAME - k] = re[k]; im[FRAME - k] = -im[k]; }
    }
    ifft(re, im);
    const start = f * HOP;
    for (let i = 0; i < FRAME; i++) {
      out[start + i] += re[i] * win[i];
      weight[start + i] += win[i] * win[i];
    }
  }
  const result = new Float32Array(n);
  for (let i = 0; i < n; i++) result[i] = weight[i] > 1e-6 ? out[i] / weight[i] : 0;
  return result;
}
