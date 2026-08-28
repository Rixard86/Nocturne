package com.nocturne.app

import kotlin.math.cos
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

/**
 * On-device acoustic analysis for classifying a sound as snore / movement / other.
 *
 * Design follows the rule-based literature (Cavusoglu, Karunajeewa, Shin & Cho):
 * snoring is low-frequency and harmonic (F0 ~90-300 Hz, most energy < ~1.5 kHz, high
 * pitch-periodicity, low spectral flatness); movement/rustling is broadband and
 * non-periodic (flat spectrum, high ZCR, no clear pitch); other sounds (speech/TV/
 * cough/traffic) are mid/high-frequency or transient.
 *
 * This file provides:
 *   - a self-contained radix-2 FFT (no external dependencies)
 *   - per-frame feature extraction (FrameFeatures)
 *   - an episode-level aggregator that turns a run of frames into a classification
 *
 * Frames are analysed at a decimated 8 kHz rate (snore/voice content lives below
 * ~3 kHz, so 8 kHz Nyquist=4 kHz is ample and keeps the FFT cheap on a phone CPU).
 */
object AcousticFeatures {

    const val FRAME_FFT = 1024          // FFT size at the decimated rate
    const val DECIM_FACTOR = 5          // 44100 / 5 = 8820 Hz (Nyquist 4410 Hz)

    // ---- radix-2 iterative FFT (in-place, real input via cos window) ----
    // re/im are size n (power of 2). Transforms in place.
    fun fft(re: DoubleArray, im: DoubleArray) {
        val n = re.size
        if (n <= 1) return
        // bit-reversal permutation
        var j = 0
        for (i in 1 until n) {
            var bit = n shr 1
            while (j and bit != 0) { j = j xor bit; bit = bit shr 1 }
            j = j or bit
            if (i < j) {
                val tr = re[i]; re[i] = re[j]; re[j] = tr
                val ti = im[i]; im[i] = im[j]; im[j] = ti
            }
        }
        var len = 2
        while (len <= n) {
            val ang = -2.0 * Math.PI / len
            val wr = cos(ang); val wi = kotlin.math.sin(ang)
            var i = 0
            while (i < n) {
                var curR = 1.0; var curI = 0.0
                for (k in 0 until len / 2) {
                    val aR = re[i + k]; val aI = im[i + k]
                    val bR = re[i + k + len / 2]; val bI = im[i + k + len / 2]
                    val tR = curR * bR - curI * bI
                    val tI = curR * bI + curI * bR
                    re[i + k] = aR + tR; im[i + k] = aI + tI
                    re[i + k + len / 2] = aR - tR; im[i + k + len / 2] = aI - tI
                    val ncurR = curR * wr - curI * wi
                    curI = curR * wi + curI * wr
                    curR = ncurR
                }
                i += len
            }
            len = len shl 1
        }
    }

    /** Per-frame features used by the classifier. */
    class FrameFeatures {
        var energy = 0.0            // total spectral energy
        var lowRatio = 0.0         // fraction of energy in 40-300 Hz (snore fundamental band)
        var midLowRatio = 0.0      // fraction in 300-1500 Hz (snore harmonics)
        var highRatio = 0.0        // fraction > 1500 Hz (consonants, rustle, hiss)
        var flatness = 0.0         // spectral flatness 0..1 (tonal→0, noise→1)
        var centroid = 0.0         // spectral centroid (Hz)
        var zcr = 0.0              // zero-crossing rate 0..1
        var f0 = 0.0               // estimated pitch (Hz), 0 if none
        var periodicity = 0.0      // autocorrelation peak strength 0..1
        var peak200 = 0.0          // energy fraction in ~180-260 Hz (snore's narrow low peak)
        var peak1k = 0.0           // energy fraction in ~800-1200 Hz (snore's wide 2nd peak)
    }

    /**
     * Extract features from a mono PCM frame already decimated to DECIM_RATE.
     * `frame` length should be FRAME_FFT. Values are normalized [-1,1] not required;
     * ratios are scale-invariant.
     */
    fun analyzeFrame(frame: DoubleArray, rate: Int, out: FrameFeatures) {
        val n = FRAME_FFT
        // zero-crossing rate (time domain)
        var zc = 0
        for (i in 1 until n) if ((frame[i] >= 0) != (frame[i - 1] >= 0)) zc++
        out.zcr = zc.toDouble() / (n - 1)

        // autocorrelation pitch on the time-domain frame (snore F0 40-300Hz)
        run {
            val minLag = rate / 300
            val maxLag = rate / 40
            var r0 = 0.0
            for (i in 0 until n) r0 += frame[i] * frame[i]
            var bestLag = 0; var bestVal = 0.0
            if (r0 > 1e-9) {
                var lag = minLag
                while (lag <= maxLag && lag < n) {
                    var s = 0.0
                    var i = 0
                    while (i < n - lag) { s += frame[i] * frame[i + lag]; i++ }
                    val norm = s / r0
                    if (norm > bestVal) { bestVal = norm; bestLag = lag }
                    lag++
                }
            }
            out.periodicity = max(0.0, min(1.0, bestVal))
            out.f0 = if (bestLag > 0 && bestVal > 0.3) rate.toDouble() / bestLag else 0.0
        }

        // windowed FFT for spectral features
        val re = DoubleArray(n); val im = DoubleArray(n)
        for (i in 0 until n) {
            val w = 0.5 - 0.5 * cos(2.0 * Math.PI * i / (n - 1)) // Hann
            re[i] = frame[i] * w
        }
        fft(re, im)
        val half = n / 2
        val binHz = rate.toDouble() / n
        var total = 0.0; var low = 0.0; var midLow = 0.0; var high = 0.0
        var p200 = 0.0; var p1k = 0.0
        var centNum = 0.0
        var logSum = 0.0; var linSum = 0.0; var cnt = 0
        for (k in 1 until half) {
            val mag = sqrt(re[k] * re[k] + im[k] * im[k])
            val p = mag * mag
            val hz = k * binHz
            total += p
            when {
                hz in 40.0..300.0 -> low += p
                hz in 300.0..1500.0 -> midLow += p
                hz > 1500.0 -> high += p
            }
            // snore's two characteristic peaks (Shin & Cho): narrow ~200 Hz + wide ~1 kHz
            if (hz in 180.0..260.0) p200 += p
            if (hz in 800.0..1200.0) p1k += p
            centNum += hz * mag
            // flatness accumulators (use magnitude, guard zero)
            val m = mag + 1e-12
            logSum += ln(m); linSum += m; cnt++
        }
        out.energy = total
        if (total > 1e-12) {
            out.lowRatio = low / total
            out.midLowRatio = midLow / total
            out.highRatio = high / total
            out.peak200 = p200 / total
            out.peak1k = p1k / total
        } else { out.lowRatio = 0.0; out.midLowRatio = 0.0; out.highRatio = 0.0; out.peak200 = 0.0; out.peak1k = 0.0 }
        val magSum = linSum
        out.centroid = if (magSum > 1e-12) centNum / magSum else 0.0
        out.flatness = if (cnt > 0 && linSum > 1e-12) {
            val geo = kotlin.math.exp(logSum / cnt)
            val arith = linSum / cnt
            max(0.0, min(1.0, geo / arith))
        } else 0.0
    }

    /**
     * Aggregates frame features across a whole detected episode and classifies it.
     * Feed each frame's features via add(); call classify() at episode end.
     */
    class EpisodeClassifier {
        private var frames = 0
        private var voicedFrames = 0        // frames with a clear low-freq pitch
        private var lowSum = 0.0
        private var midLowSum = 0.0
        private var highSum = 0.0
        private var flatSum = 0.0
        private var zcrSum = 0.0
        private var periodicitySum = 0.0
        private var f0Sum = 0.0
        private var f0Count = 0
        private var peak200Sum = 0.0
        private var peak1kSum = 0.0
        // energy-envelope stats for stationarity (steady noise = tiny variance; snoring pulses)
        private var eSum = 0.0
        private var eSumSq = 0.0
        // per-frame voiced F0 collection for exposing the episode's dominant pitch
        private var lastMeanF0 = 0.0

        /** Episode-level means and derived gates, captured on each classify() call so the
         *  service can log why an episode was or wasn't accepted. */
        class Snapshot {
            var low = 0.0; var midLow = 0.0; var high = 0.0
            var flat = 0.0; var zcr = 0.0; var periodicity = 0.0
            var voicedFrac = 0.0; var meanF0 = 0.0
            var peak200 = 0.0; var peak1k = 0.0; var eVar = 0.0
            var lowDominant = false; var twoPeak = false; var steadyNoise = false
            var snoreScore = 0; var movementScore = 0
        }

        val snapshot = Snapshot()

        fun reset() {
            frames = 0; voicedFrames = 0
            lowSum = 0.0; midLowSum = 0.0; highSum = 0.0
            flatSum = 0.0; zcrSum = 0.0; periodicitySum = 0.0
            f0Sum = 0.0; f0Count = 0
            peak200Sum = 0.0; peak1kSum = 0.0
            eSum = 0.0; eSumSq = 0.0
        }

        fun add(f: FrameFeatures) {
            frames++
            lowSum += f.lowRatio; midLowSum += f.midLowRatio; highSum += f.highRatio
            flatSum += f.flatness; zcrSum += f.zcr; periodicitySum += f.periodicity
            peak200Sum += f.peak200; peak1kSum += f.peak1k
            // track energy envelope (log to compress dynamic range) for stationarity
            val e = ln(f.energy + 1e-9)
            eSum += e; eSumSq += e * e
            if (f.f0 in 40.0..350.0 && f.periodicity > 0.4) {
                voicedFrames++; f0Sum += f.f0; f0Count++
            }
        }

        val frameCount get() = frames
        /** Dominant voiced pitch of the last classified episode (Hz), or 0. Used for
         *  per-user F0 calibration. Valid only after classify() has been called. */
        val dominantF0 get() = lastMeanF0

        /**
         * Returns one of: "snore", "movement", "other".
         * Thresholds are literature-guided and tuned conservatively:
         *  - snore:    energy concentrated < 1.5 kHz, low spectral flatness (tonal),
         *              strong periodicity / voiced fraction, low-ish ZCR, F0 90-300 Hz.
         *  - movement: broadband & non-periodic — high flatness, high ZCR, high-freq
         *              energy present, little/no pitch.
         *  - other:    everything else (mid/high tonal like speech/TV, transients).
         */
        fun classify(): String = classify(60.0, 320.0)

        /**
         * Classify with a per-user snore-F0 band [f0Lo, f0Hi]. Calibration narrows this to
         * the person's own snore pitch over the night, tightening rejection of off-pitch
         * voiced sounds (speech, TV). Defaults span the general snore range.
         */
        fun classify(f0Lo: Double, f0Hi: Double): String {
            if (frames == 0) { lastMeanF0 = 0.0; return "other" }
            val low = lowSum / frames
            val midLow = midLowSum / frames
            val high = highSum / frames
            val flat = flatSum / frames
            val zcr = zcrSum / frames
            val periodicity = periodicitySum / frames
            val voicedFrac = voicedFrames.toDouble() / frames
            val meanF0 = if (f0Count > 0) f0Sum / f0Count else 0.0
            val peak200 = peak200Sum / frames
            val peak1k = peak1kSum / frames
            val lowband = low + midLow            // energy below 1.5 kHz
            lastMeanF0 = meanF0
            snapshot.low = low; snapshot.midLow = midLow; snapshot.high = high
            snapshot.flat = flat; snapshot.zcr = zcr; snapshot.periodicity = periodicity
            snapshot.voicedFrac = voicedFrac; snapshot.meanF0 = meanF0
            snapshot.peak200 = peak200; snapshot.peak1k = peak1k

            // stationarity: variance of the log-energy envelope. Steady sources (fan, HVAC,
            // traffic hiss) barely fluctuate; snoring pulses breath-to-breath. Very low
            // variance over a multi-frame episode ⇒ steady noise, never a snore.
            val eMean = eSum / frames
            val eVar = max(0.0, eSumSq / frames - eMean * eMean)
            val steadyNoise = frames >= 8 && eVar < 0.05
            snapshot.eVar = eVar; snapshot.steadyNoise = steadyNoise

            // HARD GATE: a snore's fundamental band (40-300 Hz) must carry real energy
            // and rival the mid band. Speech/TV concentrates in 300-1500+ Hz and fails this.
            val lowDominant = low >= 0.30 && low >= midLow * 0.8
            // two-peak snore signature (Shin & Cho): a narrow ~200 Hz peak plus a ~1 kHz peak
            val twoPeak = peak200 > 0.08 && peak1k > 0.03
            snapshot.lowDominant = lowDominant; snapshot.twoPeak = twoPeak

            val snoreScore =
                (if (lowband > 0.60) 1 else 0) +
                (if (flat < 0.35) 1 else 0) +
                (if (periodicity > 0.45 || voicedFrac > 0.35) 1 else 0) +
                (if (zcr < 0.18) 1 else 0) +
                (if (meanF0 in f0Lo..f0Hi) 1 else 0) +
                (if (twoPeak) 1 else 0)

            val movementScore =
                (if (flat > 0.45) 1 else 0) +
                (if (zcr > 0.22) 1 else 0) +
                (if (high > 0.30) 1 else 0) +
                (if (periodicity < 0.35 && voicedFrac < 0.2) 1 else 0)

            snapshot.snoreScore = snoreScore; snapshot.movementScore = movementScore

            return when {
                steadyNoise -> if (movementScore >= 2) "movement" else "other"
                lowDominant && snoreScore >= 4 && snoreScore >= movementScore -> "snore"
                lowDominant && snoreScore >= 3 && flat < 0.40 && movementScore < 3 -> "snore"
                movementScore >= 3 -> "movement"
                else -> "other"
            }
        }
    }

    /**
     * Decimate a slice of 44.1kHz Short samples to Double at DECIM_FACTOR reduction,
     * appending into `dst`. Block-mean averaging provides basic anti-aliasing.
     * Returns the effective decimated rate.
     */
    fun decimateInto(src: ShortArray, len: Int, dst: ArrayList<Double>, srcRate: Int): Int {
        var i = 0
        while (i + DECIM_FACTOR <= len) {
            var s = 0.0
            for (k in 0 until DECIM_FACTOR) s += src[i + k].toDouble()
            dst.add(s / DECIM_FACTOR / 32768.0)
            i += DECIM_FACTOR
        }
        return srcRate / DECIM_FACTOR
    }
}
