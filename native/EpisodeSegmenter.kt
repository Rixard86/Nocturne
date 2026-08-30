package com.nocturne.app

import kotlin.math.log2
import kotlin.math.max
import kotlin.math.min

/**
 * Turns a stream of PCM chunks into finalized episodes.
 *
 * Kept free of Android types so a recorded night can be pushed back through exactly this
 * segmentation off-device. It owns the quiet-floor estimate, the episode state machine and
 * the per-frame acoustic accumulation. The verdict is deliberately left out: it depends on
 * the per-user F0 band the rhythm gate owns, so the caller passes the finalized episode's
 * features to [SnoreVerdict.decide] instead.
 *
 * The caller supplies each chunk's amplitude rather than the segmenter measuring it. Live
 * capture measures RMS over the full-rate read; a replay reads back the amplitude the phone
 * recorded, so the two agree even though a recording only stores the decimated stream.
 */
class EpisodeSegmenter {

    companion object {
        const val MIN_EPISODE_DUR_SEC = 0.35   // shorter than this is a breath blip, not a snore
        const val MIN_EPISODE_PEAK = 20        // must reach ~2x the room floor to be a snore
        private const val CALIBRATION_MS = 4000L
        // Quiet allowed inside one continuous episode. This must stay well BELOW the
        // inter-breath pause (typically 1.5-3.5 s) or consecutive snores merge into a single
        // episode, which then has nothing to pair with in the rhythm gate and can never be
        // confirmed. It only needs to bridge dips *within* one snore (< 0.3 s).
        private const val MERGE_GAP_MS = 700L
        private const val MAX_EPISODE_MS = 120_000L
        private const val FLOOR_WIN_MAX = 300  // ~30s at ~10 reads/s
        private const val FLOOR_LO_PCT = 0.15  // 15th percentile ~ the quiet floor
        // Lower bound on the estimated quiet floor. This only exists to stop a dead mic
        // from making every ratio infinite; it must sit BELOW any genuine room floor, since
        // a Galaxy S21 idles at 2e-5 RMS and the previous 0.001 clamped the baseline 50x
        // above the signal so no episode could ever open.
        private const val FLOOR_MIN = 0.000001
        private const val FLOOR_MAX = 0.05
        private const val LEVEL_SPAN = 14.0
        private const val DEFAULT_BASELINE = 0.012
        private const val RATIO_FLOOR = 0.0001
        private const val SHORT_FULL_SCALE = 32768.0
    }

    /**
     * One read of PCM. `samples` is either a full-rate read (live capture) or audio already
     * at the analysis rate (`decimated = true`, how a recording stores it). `amp` is always
     * the RMS of the original full-rate read.
     */
    class Chunk {
        var samples: ShortArray = ShortArray(0)
        var length = 0
        var atMs = 0L
        var amp = 0.0
        var decimated = false
    }

    /** What this chunk measured, and any episode it closed. */
    class Reading {
        var amp = 0.0
        var baseline = 0.0
        var ratio = 0.0
        var level = 0
        var calibrating = false
        var calibLeftSec = 0.0
        var calibrationComplete = false
        var episodeStarted = false
        var finalized: Episode? = null
    }

    class Episode {
        var onset = 0.0
        var durSec = 0.0
        var peak = 0
        var baseline = 0.0
        var frames = 0
        var forced = false
        var features: SnoreVerdict.Features? = null
    }

    var sensitivityRatio = 1.4

    private var analysisRate = 44100 / AcousticFeatures.DECIM_FACTOR
    private var startMs = 0L
    private var baseline = DEFAULT_BASELINE
    private var calibrating = true
    private var calibStart = 0L
    private val calibSamples = ArrayList<Double>()
    private val floorWin = ArrayDeque<Double>()

    private var epActive = false
    private var epStartMs = 0L
    private var epLastActiveMs = 0L
    private var epPeak = 0

    private val classifier = AcousticFeatures.EpisodeClassifier()
    private val frameBuf = ArrayList<Double>(AcousticFeatures.FRAME_FFT * 3)
    private val analysisFrame = DoubleArray(AcousticFeatures.FRAME_FFT)
    private val frameFeat = AcousticFeatures.FrameFeatures()

    val active get() = epActive
    val currentBaseline get() = baseline

    fun begin(rate: Int, atMs: Long) {
        analysisRate = rate
        startMs = atMs
        calibStart = atMs
        calibrating = true
        calibSamples.clear()
        floorWin.clear()
        baseline = DEFAULT_BASELINE
        epActive = false
        classifier.reset()
        frameBuf.clear()
    }

    fun accept(chunk: Chunk): Reading {
        val reading = Reading()
        reading.amp = chunk.amp
        if (calibrating) return calibrate(chunk.atMs, reading)
        updateFloor(reading.amp)
        reading.baseline = baseline
        reading.ratio = reading.amp / max(baseline, RATIO_FLOOR)
        reading.level = soundLevel(reading.amp)
        track(chunk, reading)
        return reading
    }

    /** Close an episode still open when capture stops. */
    fun flush(): Episode? = if (epActive) finalize(false) else null

    private fun calibrate(atMs: Long, reading: Reading): Reading {
        calibSamples.add(reading.amp)
        reading.calibrating = true
        reading.baseline = baseline
        reading.calibLeftSec = max(0L, CALIBRATION_MS - (atMs - calibStart)) / 1000.0
        if (atMs - calibStart < CALIBRATION_MS) return reading
        val sorted = calibSamples.sorted()
        val median = if (sorted.isEmpty()) DEFAULT_BASELINE else sorted[sorted.size / 2]
        baseline = max(FLOOR_MIN, median)
        // seed the rolling floor with the calibration samples so it starts from measured
        // room tone and adapts from there
        floorWin.clear()
        floorWin.addAll(calibSamples)
        while (floorWin.size > FLOOR_WIN_MAX) floorWin.removeFirst()
        calibrating = false
        reading.calibrationComplete = true
        reading.baseline = baseline
        return reading
    }

    /**
     * Adaptive quiet floor: a low percentile of a rolling window, clamped. Tracks the true
     * room floor up or down and cannot be pinned by a bad calibration.
     */
    private fun updateFloor(amp: Double) {
        floorWin.addLast(amp)
        while (floorWin.size > FLOOR_WIN_MAX) floorWin.removeFirst()
        val sorted = floorWin.sorted()
        baseline = sorted[((sorted.size - 1) * FLOOR_LO_PCT).toInt()].coerceIn(FLOOR_MIN, FLOOR_MAX)
    }

    private fun track(chunk: Chunk, reading: Reading) {
        val now = chunk.atMs
        if (reading.ratio > sensitivityRatio) {
            if (!epActive) {
                epActive = true
                epStartMs = now
                epLastActiveMs = now
                epPeak = reading.level
                classifier.reset()
                frameBuf.clear()
                reading.episodeStarted = true
            } else {
                epLastActiveMs = now
                if (reading.level > epPeak) epPeak = reading.level
            }
        }
        if (epActive) analyse(chunk)
        // finalize only after continuous quiet beyond the merge gap; the length guard then
        // cuts a sound that never drops below the gate at all (a fan, an AC turning on)
        if (epActive && (now - epLastActiveMs) >= MERGE_GAP_MS) {
            reading.finalized = finalize(false)
        } else if (epActive && (now - epStartMs) > MAX_EPISODE_MS) {
            reading.finalized = finalize(true)
        }
    }

    private fun analyse(chunk: Chunk) {
        if (chunk.decimated) {
            for (i in 0 until chunk.length) frameBuf.add(chunk.samples[i] / SHORT_FULL_SCALE)
        } else {
            AcousticFeatures.decimateInto(chunk.samples, chunk.length, frameBuf, analysisRate)
        }
        while (frameBuf.size >= AcousticFeatures.FRAME_FFT) {
            for (i in 0 until AcousticFeatures.FRAME_FFT) analysisFrame[i] = frameBuf[i]
            // drop the consumed frame in one shift (not one element at a time)
            frameBuf.subList(0, AcousticFeatures.FRAME_FFT).clear()
            AcousticFeatures.analyzeFrame(analysisFrame, analysisRate, frameFeat)
            classifier.add(frameFeat)
        }
    }

    private fun finalize(forced: Boolean): Episode {
        val ep = Episode()
        ep.onset = (epStartMs - startMs) / 1000.0
        ep.durSec = (epLastActiveMs - epStartMs) / 1000.0
        ep.peak = epPeak
        ep.baseline = baseline
        ep.frames = classifier.frameCount
        ep.forced = forced
        ep.features = classifier.featureMeans()
        epActive = false
        classifier.reset()
        frameBuf.clear()
        return ep
    }

    private fun soundLevel(amp: Double): Int {
        val base = if (baseline > 0) baseline else 0.01
        val ratio = max(1.0, amp / base)
        val level = log2(ratio) / log2(LEVEL_SPAN) * 100.0
        return max(0.0, min(100.0, level)).toInt()
    }
}
