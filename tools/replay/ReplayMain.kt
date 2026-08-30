package com.nocturne.replay

import com.nocturne.app.SnoreConfirmer
import com.nocturne.app.SnoreVerdict
import java.io.File
import java.util.Locale
import kotlin.math.abs

class ReplayTotals {
    var episodesLogged = 0
    var classified = 0
    var kindMatched = 0
    var gatesMatched = 0
    var loggedSnores = 0
    var replayedSnores = 0
    var edgeExplained = 0
    val kinds = LinkedHashMap<String, Int>()
    val divergences = ArrayList<String>()
}

/**
 * Push a recorded night back through the shipping decision path.
 *
 * Classification and rhythm confirmation run together and in order because the F0
 * calibration is a feedback loop: the band that classifies an episode is derived from the
 * snores the gate has already confirmed. Replaying either half alone would drift.
 */
class Replay {

    private val confirmer = SnoreConfirmer()
    private var showAll = false

    fun run(file: File, verbose: Boolean): ReplayTotals {
        showAll = verbose
        val totals = ReplayTotals()
        for (line in file.readLines()) {
            if (line.contains("\"e\":\"snore\"")) totals.loggedSnores++
            if (line.contains("\"e\":\"epi\"")) totals.episodesLogged++
            val ep = EpisodeParser.parse(line) ?: continue
            totals.classified++
            score(ep, totals)
        }
        totals.replayedSnores = confirmer.confirmedCount
        return totals
    }

    private fun score(ep: LoggedEpisode, totals: ReplayTotals) {
        val decision = SnoreVerdict.decide(ep.features, confirmer.band)
        val kind = finalKind(ep, decision)
        totals.kinds[kind] = (totals.kinds[kind] ?: 0) + 1
        val sameKind = kind == ep.kind
        val sameGates = gatesAgree(ep, decision)
        if (sameKind) totals.kindMatched++
        if (sameGates) totals.gatesMatched++
        if (!sameKind || !sameGates) {
            totals.divergences.add(describe(ep, decision))
            if (atLoggingEdge(ep.features)) totals.edgeExplained++
        }
        if (showAll) println("  " + describe(ep, decision))
        if (kind == SnoreVerdict.SNORE) confirmer.offer(ep.asCandidate())
    }

    /** The duration cap is applied by the service after classification, so replay it here. */
    private fun finalKind(ep: LoggedEpisode, decision: SnoreVerdict.Decision): String =
        if (SnoreVerdict.exceedsSnoreDuration(decision.kind, ep.durSec)) SnoreVerdict.OTHER
        else decision.kind

    private fun gatesAgree(ep: LoggedEpisode, decision: SnoreVerdict.Decision): Boolean =
        decision.snoreScore == ep.snoreScore &&
            decision.movementScore == ep.movementScore &&
            decision.lowDominant == ep.lowDominant &&
            decision.twoPeak == ep.twoPeak &&
            decision.steadyNoise == ep.steadyNoise

    private fun describe(ep: LoggedEpisode, d: SnoreVerdict.Decision): String {
        val kind = finalKind(ep, d)
        val notes = ArrayList<String>()
        if (kind != ep.kind) notes.add("kind")
        if (!gatesAgree(ep, d)) notes.add("gates")
        if (atLoggingEdge(ep.features)) notes.add("edge")
        return String.format(
            Locale.US,
            "t=%8.1f dur=%5.2f f0=%6.1f flat=%.3f zcr=%.3f s=%d/%d m=%d/%d %-8s logged=%-8s %s",
            ep.onset, ep.durSec, ep.features.meanF0, ep.features.flat, ep.features.zcr,
            d.snoreScore, ep.snoreScore, d.movementScore, ep.movementScore,
            kind, ep.kind, notes.joinToString(","),
        )
    }

    /**
     * The log rounds features to three decimals and F0 to one, so a value sitting exactly
     * on a threshold scores differently here than it did on the phone, where the unrounded
     * value decided it. Such a divergence is a limit of the recording's precision, not a
     * difference in behaviour, and is counted separately.
     */
    private fun atLoggingEdge(f: SnoreVerdict.Features): Boolean =
        onScoreThreshold(f) || onBandEdge(f.meanF0)

    private fun onScoreThreshold(f: SnoreVerdict.Features): Boolean =
        f.flat == 0.35 || f.flat == 0.40 || f.flat == 0.45 ||
            f.zcr == 0.18 || f.zcr == 0.22 ||
            f.high == 0.30 || f.periodicity == 0.45 || f.periodicity == 0.35 ||
            f.voicedFrac == 0.35 || f.voicedFrac == 0.20 ||
            f.peak200 == 0.08 || f.peak1k == 0.03 ||
            f.low + f.midLow == 0.60 || f.low == 0.30

    private fun onBandEdge(meanF0: Double): Boolean =
        abs(meanF0 - confirmer.band.lo) <= F0_LOG_STEP ||
            abs(meanF0 - confirmer.band.hi) <= F0_LOG_STEP

    private companion object {
        const val F0_LOG_STEP = 0.05
    }
}
