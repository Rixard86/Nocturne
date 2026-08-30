package com.nocturne.app

import java.util.Locale

/**
 * Builds the diagnostic JSON-lines records written alongside the normal session events.
 *
 * The detector runs nine serial gates, and until now an episode rejected by any of them
 * vanished with no trace — which made threshold tuning guesswork. Every episode now emits
 * one line carrying its features and the gate that rejected it, so a night of recording
 * answers "which gate is eating the snores" with a histogram instead of an argument.
 *
 * These lines use their own event names ("epi", "rhythm", "cfg") so the existing UI
 * readers, which switch on "sample"/"snore"/"pause"/"sound", ignore them.
 */
object EpisodeLog {

    // Reject reasons. REASON_NONE means the episode passed every gate and was emitted.
    const val REASON_NONE = "none"
    const val REASON_SHORT = "dur<min"
    const val REASON_QUIET = "peak<min"
    const val REASON_MAX_EPISODE = "maxEpisode"
    const val REASON_TOO_LONG = "dur>max"
    const val REASON_NOT_SNORE = "class:"

    private fun num(value: Double, decimals: Int): String =
        String.format(Locale.US, "%.${decimals}f", value)

    private fun bool(value: Boolean): String = if (value) "1" else "0"

    /**
     * One line per finalized episode, including those dropped before classification.
     * `kind` is the classifier verdict, or null when the episode never reached it.
     */
    fun episode(episode: EpisodeRecord, features: AcousticFeatures.EpisodeClassifier.Snapshot?): String {
        val head = StringBuilder()
            .append("{\"e\":\"epi\"")
            .append(",\"t\":").append(num(episode.onset, 1))
            .append(",\"dur\":").append(num(episode.durSec, 2))
            .append(",\"peak\":").append(episode.peak)
            .append(",\"base\":").append(String.format(Locale.US, "%.3e", episode.baseline))
            .append(",\"frames\":").append(episode.frames)
            .append(",\"kind\":\"").append(episode.kind).append("\"")
            .append(",\"reject\":\"").append(episode.reject).append("\"")
        if (features == null) return head.append("}").toString()
        return head
            .append(",\"low\":").append(num(features.low, 3))
            .append(",\"midLow\":").append(num(features.midLow, 3))
            .append(",\"high\":").append(num(features.high, 3))
            .append(",\"flat\":").append(num(features.flat, 3))
            .append(",\"zcr\":").append(num(features.zcr, 3))
            .append(",\"per\":").append(num(features.periodicity, 3))
            .append(",\"voiced\":").append(num(features.voicedFrac, 3))
            .append(",\"f0\":").append(num(features.meanF0, 1))
            .append(",\"p200\":").append(num(features.peak200, 3))
            .append(",\"p1k\":").append(num(features.peak1k, 3))
            .append(",\"eVar\":").append(num(features.eVar, 4))
            .append(",\"lowDom\":").append(bool(features.lowDominant))
            .append(",\"twoPeak\":").append(bool(features.twoPeak))
            .append(",\"steady\":").append(bool(features.steadyNoise))
            .append(",\"sScore\":").append(features.snoreScore)
            .append(",\"mScore\":").append(features.movementScore)
            .append("}")
            .toString()
    }

    /**
     * One line per rhythm-gate decision. A snore is only emitted when two candidates pair
     * within the train window, so this is where a correct classification is most often lost.
     */
    fun rhythm(onset: Double, gaps: RhythmGaps, outcome: String): String =
        "{\"e\":\"rhythm\",\"t\":${num(onset, 1)}" +
            ",\"gapConf\":${num(gaps.fromConfirmed, 2)}" +
            ",\"gapPend\":${num(gaps.fromPending, 2)}" +
            ",\"out\":\"$outcome\"}"

    /** Capture configuration, written once at session start. */
    fun config(source: String, rates: CaptureRates): String =
        "{\"e\":\"cfg\",\"src\":\"$source\"" +
            ",\"sampleRate\":${rates.sampleRate}" +
            ",\"minBuf\":${rates.minBuf}" +
            ",\"readSamples\":${rates.readSamples}" +
            ",\"agc\":\"${rates.agc}\"" +
            ",\"ns\":\"${rates.noiseSuppressor}\"" +
            ",\"device\":\"${rates.device}\"}"

    /** Fields describing one finalized episode. */
    class EpisodeRecord {
        var onset = 0.0
        var durSec = 0.0
        var peak = 0
        var baseline = 0.0
        var frames = 0
        var kind = "none"
        var reject = REASON_NONE
    }

    /** Onset gaps considered by the rhythm gate, in seconds. */
    class RhythmGaps(val fromConfirmed: Double, val fromPending: Double)

    /** Capture-path facts worth knowing when a night looks wrong. */
    class CaptureRates(val sampleRate: Int, val minBuf: Int, val readSamples: Int) {
        var agc = "n/a"
        var noiseSuppressor = "n/a"
        var device = ""
    }
}
