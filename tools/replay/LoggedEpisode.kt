package com.nocturne.replay

import com.nocturne.app.SnoreConfirmer
import com.nocturne.app.SnoreVerdict

/** One finalized episode as the device recorded it: its features and its verdict. */
class LoggedEpisode {
    var onset = 0.0
    var durSec = 0.0
    var peak = 0
    var kind = ""
    var reject = ""
    val features = SnoreVerdict.Features()
    var snoreScore = 0
    var movementScore = 0
    var lowDominant = false
    var twoPeak = false
    var steadyNoise = false

    /** The device feeds the gate the episode mean F0, which is what dominantF0 returns. */
    fun asCandidate(): SnoreConfirmer.Candidate {
        val candidate = SnoreConfirmer.Candidate()
        candidate.onset = onset
        candidate.durSec = durSec
        candidate.peak = peak
        candidate.f0 = features.meanF0
        return candidate
    }
}

object EpisodeParser {

    /**
     * Parse an "epi" line, or return null for any other event and for episodes that never
     * reached the classifier — those carry no features, so there is nothing to replay.
     */
    fun parse(line: String): LoggedEpisode? {
        if (JsonLine.string(line, "e") != "epi") return null
        if (JsonLine.double(line, "low") == null) return null
        val ep = LoggedEpisode()
        ep.onset = JsonLine.double(line, "t") ?: 0.0
        ep.durSec = JsonLine.double(line, "dur") ?: 0.0
        ep.peak = JsonLine.int(line, "peak") ?: 0
        ep.kind = JsonLine.string(line, "kind") ?: ""
        ep.reject = JsonLine.string(line, "reject") ?: ""
        ep.snoreScore = JsonLine.int(line, "sScore") ?: 0
        ep.movementScore = JsonLine.int(line, "mScore") ?: 0
        ep.lowDominant = JsonLine.flag(line, "lowDom")
        ep.twoPeak = JsonLine.flag(line, "twoPeak")
        ep.steadyNoise = JsonLine.flag(line, "steady")
        readFeatures(line, ep.features)
        return ep
    }

    private fun readFeatures(line: String, f: SnoreVerdict.Features) {
        f.frames = JsonLine.int(line, "frames") ?: 0
        f.low = JsonLine.double(line, "low") ?: 0.0
        f.midLow = JsonLine.double(line, "midLow") ?: 0.0
        f.high = JsonLine.double(line, "high") ?: 0.0
        f.flat = JsonLine.double(line, "flat") ?: 0.0
        f.zcr = JsonLine.double(line, "zcr") ?: 0.0
        f.periodicity = JsonLine.double(line, "per") ?: 0.0
        f.voicedFrac = JsonLine.double(line, "voiced") ?: 0.0
        f.meanF0 = JsonLine.double(line, "f0") ?: 0.0
        f.peak200 = JsonLine.double(line, "p200") ?: 0.0
        f.peak1k = JsonLine.double(line, "p1k") ?: 0.0
        f.eVar = JsonLine.double(line, "eVar") ?: 0.0
    }
}
