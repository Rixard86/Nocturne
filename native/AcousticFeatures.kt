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
        var logSum = 0.0; var linSum = 0.0; var cnt = 0; var magSum = 0.0
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
            magSum += mag
            // Spectral flatness is the geometric over the arithmetic mean of the POWER
            // spectrum. Accumulating magnitude instead inflates it badly: measured on real
            // snore clips it read 0.570 where the correct value is 0.043, which both failed
            // the tonal test (< 0.35) and tripped the broadband movement test (> 0.45) on
            // the same episode. Every flatness threshold below is calibrated to this scale.
            val pw = p + 1e-20
            logSum += ln(pw); linSum += pw; cnt++
        }
        out.energy = total
        if (total > 1e-12) {
            out.lowRatio = low / total
            out.midLowRatio = midLow / total
            out.highRatio = high / total
            out.peak200 = p200 / total
            out.peak1k = p1k / total
        } else { out.lowRatio = 0.0; out.midLowRatio = 0.0; out.highRatio = 0.0; out.peak200 = 0.0; out.peak1k = 0.0 }
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

        /**
         * Collapse the accumulated per-frame sums into this episode's feature means, or
         * null if no frame was ever analysed. The verdict is deliberately not taken here:
         * it depends on the per-user F0 band, which the rhythm gate owns, so the caller
         * passes both to [SnoreVerdict.decide]. That keeps one decision path for the
         * device and the replay harness.
         */
        fun featureMeans(): SnoreVerdict.Features? {
            if (frames == 0) return null
            val f = SnoreVerdict.Features()
            f.frames = frames
            f.low = lowSum / frames
            f.midLow = midLowSum / frames
            f.high = highSum / frames
            f.flat = flatSum / frames
            f.zcr = zcrSum / frames
            f.periodicity = periodicitySum / frames
            f.voicedFrac = voicedFrames.toDouble() / frames
            f.meanF0 = if (f0Count > 0) f0Sum / f0Count else 0.0
            f.peak200 = peak200Sum / frames
            f.peak1k = peak1kSum / frames
            val eMean = eSum / frames
            f.eVar = max(0.0, eSumSq / frames - eMean * eMean)
            return f
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
