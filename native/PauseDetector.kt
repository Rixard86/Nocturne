package com.nocturne.app

/**
 * Breathing-pause detection, extracted from the capture service so a replay can drive the
 * real state machine instead of a paraphrase of it.
 *
 * This lived inside `AudioCaptureService` and so had no test coverage at all, while the
 * snore path was pulled out into pure files and measured repeatedly. That asymmetry showed:
 * a night with 1,067 confirmed snores produced zero pauses, and finding out why needed the
 * gates re-implemented by hand in a throwaway script. Now the harness runs this code.
 *
 * A pause is loud-then-silent-then-loud around an established snore. It is deliberately not
 * "any long silence": a quiet stretch between snoring bouts is not a breathing pause, so the
 * silence has to begin close behind a confirmed snore of a plausible length.
 */
class PauseDetector {

    companion object {
        const val SILENCE_FACTOR = 1.2      // amp below baseline x this counts as true silence
        const val MIN_PAUSE_SEC = 9.0
        const val MAX_PAUSE_SEC = 60.0
        const val MIN_SNORE_BEFORE_SEC = 2.0
        const val SLACK_SEC = 2.0           // the silence may start just before the snore ends
        const val MAX_SINCE_SNORE_SEC = 20.0

        // A pause is evidence of absence, so a clip of it must carry the arc: the breathing
        // before, the silence, and the recovery breath after. Silence alone proves nothing.
        const val PRE_ROLL_SEC = 3
        const val POST_ROLL_SEC = 4
    }

    class Pause {
        var startMs = 0L
        var endMs = 0L
        var durSec = 0.0
    }

    /**
     * Why candidate silences were turned down. Kept for the same reason every episode logs
     * its reject reason: without it, "no pauses" is indistinguishable from "no pauses that
     * survived gate 4", and tuning becomes guesswork.
     */
    class Rejects {
        var tooShort = 0
        var tooLong = 0
        var noSnore = 0
        var snoreTooFar = 0
        var snoreTooShort = 0
    }

    val rejects = Rejects()

    private var silentSinceMs = 0L
    private var lastSnoreEndMs = 0L
    private var lastSnoreDurSec = 0.0
    private var pendingStartMs = 0L
    private var pendingEndMs = 0L

    /** Arm the gate. Only a CONFIRMED snore counts; a loud noise is not breathing. */
    fun noteConfirmedSnore(endMs: Long, durSec: Double) {
        lastSnoreEndMs = endMs
        lastSnoreDurSec = durSec
    }

    /**
     * Feed one read. Returns a pause only once its recovery breath has had time to be
     * recorded, so a caller writing a clip captures the whole arc rather than the first
     * instant of the gasp.
     */
    fun observe(reading: EpisodeSegmenter.Reading, atMs: Long): Pause? {
        if (reading.amp < reading.baseline * SILENCE_FACTOR) {
            if (silentSinceMs == 0L) silentSinceMs = atMs
        } else {
            if (silentSinceMs != 0L) close(atMs)
            silentSinceMs = 0L
        }
        return flush(atMs, false)
    }

    /**
     * Release a held pause. `force` skips the post-roll wait, for a stop where no further
     * audio is coming and waiting would discard the event entirely.
     */
    fun flush(atMs: Long, force: Boolean): Pause? {
        if (pendingEndMs == 0L) return null
        if (!force && atMs - pendingEndMs < POST_ROLL_SEC * 1000L) return null
        val pause = Pause()
        pause.startMs = pendingStartMs
        pause.endMs = pendingEndMs
        pause.durSec = (pendingEndMs - pendingStartMs) / 1000.0
        pendingStartMs = 0L
        pendingEndMs = 0L
        return pause
    }

    /** Gate a completed silence, counting which test turned it down. */
    private fun close(atMs: Long) {
        val gap = (atMs - silentSinceMs) / 1000.0
        val sinceSnore =
            if (lastSnoreEndMs != 0L) (silentSinceMs - lastSnoreEndMs) / 1000.0 else Double.MAX_VALUE
        when {
            gap < MIN_PAUSE_SEC -> rejects.tooShort++
            gap > MAX_PAUSE_SEC -> rejects.tooLong++
            lastSnoreEndMs == 0L -> rejects.noSnore++
            sinceSnore > MAX_SINCE_SNORE_SEC || sinceSnore < -SLACK_SEC -> rejects.snoreTooFar++
            lastSnoreDurSec < MIN_SNORE_BEFORE_SEC -> rejects.snoreTooShort++
            else -> {
                pendingStartMs = silentSinceMs
                pendingEndMs = atMs
            }
        }
    }
}
