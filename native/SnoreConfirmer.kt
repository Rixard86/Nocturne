package com.nocturne.app

import kotlin.math.max
import kotlin.math.min

/**
 * The rhythm gate: a snore-like episode only becomes a confirmed snore when it forms a
 * train with another one. Periodicity across episodes is the decisive cue and the main
 * defense against false positives — a lone voiced burst (a grunt, a word of sleep-talk)
 * should not count, but a burst that is one of a train almost certainly is snoring.
 *
 * Kept free of Android types so a recorded night can be replayed through it off-device.
 * It also owns the per-user F0 calibration, because that band is fed only by snores this
 * gate confirms, and the feedback loop is only reproducible if both halves run together.
 */
class SnoreConfirmer {

    /**
     * Onset-to-onset gap between consecutive snores in a train. The upper bound sets the
     * slowest breathing rate that can be confirmed: 8.0 s covers down to 7.5 breaths/min,
     * and with the 0.7 s merge gap the lower bound reaches 40 breaths/min — the whole
     * physiological range. (At the previous 4 s merge gap the achievable range collapsed
     * to 8.6-13.8 breaths/min, below normal adult sleeping rates, so almost nothing could
     * ever be confirmed.)
     */
    private val trainMinSec = 1.5
    private val trainMaxSec = 8.0

    private val f0CalibrateAfter = 8
    private val f0SamplesMax = 200
    private val f0AcceptLo = 50.0
    private val f0AcceptHi = 400.0
    private val f0SpreadBelow = 90.0
    private val f0SpreadAbove = 120.0

    // twoPeak needs 1 kHz energy this hardware does not capture, so 5 is the practical
    // maximum of the six-point score, not 6.
    private val certainScore = 5
    private val noConfirmedOnset = -100.0
    private val noPendingOnset = -1.0

    /** One snore-like episode offered to the gate. */
    class Candidate {
        var onset = 0.0
        var durSec = 0.0
        var peak = 0
        var clip = ""
        var f0 = 0.0
        var score = 0
    }

    /** What the gate did, and which candidates it confirmed as a result. */
    class Outcome {
        var branch = ""
        var gapFromConfirmed = 0.0
        var gapFromPending = -1.0
        val confirmed = ArrayList<Candidate>()
    }

    private var pending: Candidate? = null
    private var lastConfirmedOnset = noConfirmedOnset
    private val f0Samples = ArrayList<Double>()

    var band = SnoreVerdict.defaultBand
        private set

    val confirmedCount get() = totalConfirmed
    private var totalConfirmed = 0

    fun offer(candidate: Candidate): Outcome {
        val outcome = Outcome()
        val held = pending
        outcome.gapFromConfirmed = candidate.onset - lastConfirmedOnset
        outcome.gapFromPending = if (held != null) candidate.onset - held.onset else noPendingOnset

        if (isTrainGap(outcome.gapFromConfirmed)) {
            outcome.branch = "confirmed-by-train"
            confirm(candidate, outcome)
            return outcome
        }
        // A candidate carrying every point the classifier can award needs no partner. The
        // pairing rule exists to reject lone voiced bursts, not to discard snores that are
        // simply isolated - measured on a labelled night, 3 of 20 real snores were already
        // classified `snore` and lost here for having nothing to pair with.
        if (candidate.score >= certainScore) {
            outcome.branch = "confirmed-alone"
            confirm(candidate, outcome)
            return outcome
        }
        if (held == null) {
            outcome.branch = "held-pending"
            pending = candidate
            return outcome
        }
        if (isTrainGap(outcome.gapFromPending)) {
            outcome.branch = "confirmed-pair"
            confirm(held, outcome)
            confirm(candidate, outcome)
            pending = null
            return outcome
        }
        outcome.branch = "pending-dropped"
        pending = candidate
        return outcome
    }

    private fun isTrainGap(gap: Double): Boolean = gap >= trainMinSec && gap <= trainMaxSec

    private fun confirm(candidate: Candidate, outcome: Outcome) {
        totalConfirmed++
        lastConfirmedOnset = candidate.onset
        outcome.confirmed.add(candidate)
        if (candidate.f0 >= f0AcceptLo && candidate.f0 <= f0AcceptHi) {
            f0Samples.add(candidate.f0)
            if (f0Samples.size >= f0CalibrateAfter) recalibrate()
        }
    }

    /** Narrow the accepted snore-F0 band to this user's own pitch (median +/- spread). */
    private fun recalibrate() {
        val sorted = f0Samples.sorted()
        val median = sorted[sorted.size / 2]
        band = SnoreVerdict.F0Band(
            max(f0AcceptLo, median - f0SpreadBelow),
            min(f0AcceptHi, median + f0SpreadAbove),
        )
        if (f0Samples.size > f0SamplesMax) {
            f0Samples.subList(0, f0Samples.size - f0SamplesMax).clear()
        }
    }
}
