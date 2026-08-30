package com.nocturne.app

/**
 * The episode verdict as a pure function of measured features.
 *
 * This lives apart from both the capture service and the frame analyser so the same
 * decision can be replayed off-device: the diagnostic log records exactly the fields of
 * [Features], so a recorded night can be pushed back through [decide] and the verdicts
 * compared against what the phone actually decided. Changing a threshold here changes it
 * for the device and the replay harness together, which is the only way a tuning change
 * can be measured before it ships.
 */
object SnoreVerdict {

    const val SNORE = "snore"
    const val MOVEMENT = "movement"
    const val OTHER = "other"

    private const val LOWBAND_MIN = 0.60
    private const val FLAT_TONAL_MAX = 0.35
    private const val FLAT_TONAL_RELAXED = 0.40
    private const val PERIODICITY_MIN = 0.45
    private const val VOICED_MIN = 0.35
    private const val ZCR_TONAL_MAX = 0.18

    private const val FLAT_BROADBAND_MIN = 0.45
    private const val ZCR_BROADBAND_MIN = 0.22
    private const val HIGH_BAND_MIN = 0.30
    private const val PERIODICITY_WEAK = 0.35
    private const val VOICED_WEAK = 0.20

    private const val LOW_ENERGY_MIN = 0.30
    private const val LOW_VS_MIDLOW = 0.8
    private const val PEAK_200_MIN = 0.08
    private const val PEAK_1K_MIN = 0.03

    private const val STEADY_FRAMES_MIN = 8
    private const val STEADY_EVAR_MAX = 0.05

    private const val SNORE_SCORE_STRONG = 4
    private const val SNORE_SCORE_RELAXED = 3
    private const val MOVEMENT_SCORE_MIN = 3
    private const val MOVEMENT_SCORE_STEADY = 2

    /**
     * A snore is one exhalation, so it cannot run indefinitely: measured over a real night,
     * genuine snores had a median duration of 2.0 s and a 90th percentile of 3.2 s. Sound
     * that never drops below the gate for longer than this is a continuous source — a
     * radio, a fan, a TV — which the spectral classifier alone was letting through.
     */
    const val MAX_SNORE_DUR_SEC = 4.0

    /** Per-episode feature means, exactly the set the diagnostic log records. */
    class Features {
        var frames = 0
        var low = 0.0
        var midLow = 0.0
        var high = 0.0
        var flat = 0.0
        var zcr = 0.0
        var periodicity = 0.0
        var voicedFrac = 0.0
        var meanF0 = 0.0
        var peak200 = 0.0
        var peak1k = 0.0
        var eVar = 0.0
    }

    /** Accepted snore-pitch range, narrowed per user by calibration. */
    class F0Band(val lo: Double, val hi: Double)

    /** The verdict plus the intermediate gates, so a rejection is always explicable. */
    class Decision {
        var kind = OTHER
        var lowDominant = false
        var twoPeak = false
        var steadyNoise = false
        var snoreScore = 0
        var movementScore = 0
    }

    val defaultBand get() = F0Band(60.0, 320.0)

    fun decide(f: Features, band: F0Band): Decision {
        val d = Decision()
        d.steadyNoise = f.frames >= STEADY_FRAMES_MIN && f.eVar < STEADY_EVAR_MAX
        d.lowDominant = f.low >= LOW_ENERGY_MIN && f.low >= f.midLow * LOW_VS_MIDLOW
        d.twoPeak = hasTwoPeaks(f)
        d.snoreScore = snoreScore(f, band)
        d.movementScore = movementScore(f)
        d.kind = kindFor(f, d)
        return d
    }

    /** Continuous sound is not breathing, however snore-like its spectrum. */
    fun exceedsSnoreDuration(kind: String, durSec: Double): Boolean =
        kind == SNORE && durSec > MAX_SNORE_DUR_SEC

    private fun hasTwoPeaks(f: Features): Boolean =
        f.peak200 > PEAK_200_MIN && f.peak1k > PEAK_1K_MIN

    private fun snoreScore(f: Features, band: F0Band): Int =
        (if (f.low + f.midLow > LOWBAND_MIN) 1 else 0) +
        (if (f.flat < FLAT_TONAL_MAX) 1 else 0) +
        (if (f.periodicity > PERIODICITY_MIN || f.voicedFrac > VOICED_MIN) 1 else 0) +
        (if (f.zcr < ZCR_TONAL_MAX) 1 else 0) +
        (if (f.meanF0 >= band.lo && f.meanF0 <= band.hi) 1 else 0) +
        (if (hasTwoPeaks(f)) 1 else 0)

    private fun movementScore(f: Features): Int =
        (if (f.flat > FLAT_BROADBAND_MIN) 1 else 0) +
        (if (f.zcr > ZCR_BROADBAND_MIN) 1 else 0) +
        (if (f.high > HIGH_BAND_MIN) 1 else 0) +
        (if (f.periodicity < PERIODICITY_WEAK && f.voicedFrac < VOICED_WEAK) 1 else 0)

    private fun kindFor(f: Features, d: Decision): String = when {
        d.steadyNoise -> if (d.movementScore >= MOVEMENT_SCORE_STEADY) MOVEMENT else OTHER
        d.lowDominant && d.snoreScore >= SNORE_SCORE_STRONG &&
            d.snoreScore >= d.movementScore -> SNORE
        d.lowDominant && d.snoreScore >= SNORE_SCORE_RELAXED &&
            f.flat < FLAT_TONAL_RELAXED && d.movementScore < MOVEMENT_SCORE_MIN -> SNORE
        d.movementScore >= MOVEMENT_SCORE_MIN -> MOVEMENT
        else -> OTHER
    }
}
