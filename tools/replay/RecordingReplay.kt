package com.nocturne.replay

import com.nocturne.app.EpisodeSegmenter
import com.nocturne.app.SnoreConfirmer
import com.nocturne.app.SnoreVerdict
import java.util.Locale

class RecordingTotals {
    var chunks = 0
    var seconds = 0.0
    var episodes = 0
    var classified = 0
    var confirmedSnores = 0
    val kinds = LinkedHashMap<String, Int>()
    val episodeLines = ArrayList<String>()
    val confirmedOnsets = ArrayList<Double>()
}

/**
 * Replays a recorded night through the real segmenter, classifier and rhythm gate.
 *
 * Unlike the event-log replay this starts from audio, so it exercises feature extraction as
 * well as the decision layer — which is what makes the blocked detector changes (the pitch
 * band, the flatness and autocorrelation biases) measurable instead of guesswork.
 */
class RecordingReplay {

    private val segmenter = EpisodeSegmenter()
    private val confirmer = SnoreConfirmer()

    fun run(recording: Recording): RecordingTotals {
        val totals = RecordingTotals()
        segmenter.begin(recording.analysisRate, 0L)
        segmenter.sensitivityRatio = recording.sensitivity
        val read = Recording.Read()
        val chunk = EpisodeSegmenter.Chunk()
        chunk.decimated = recording.decimated
        while (recording.next(read)) {
            totals.chunks++
            totals.seconds = read.atMs / 1000.0
            chunk.samples = read.samples
            chunk.length = read.count
            chunk.atMs = read.atMs.toLong()
            chunk.amp = read.amp
            segmenter.accept(chunk).finalized?.let { take(it, totals) }
        }
        segmenter.flush()?.let { take(it, totals) }
        totals.confirmedSnores = confirmer.confirmedCount
        return totals
    }

    private fun take(episode: EpisodeSegmenter.Episode, totals: RecordingTotals) {
        totals.episodes++
        if (episode.durSec <= EpisodeSegmenter.MIN_EPISODE_DUR_SEC) return
        if (episode.peak < EpisodeSegmenter.MIN_EPISODE_PEAK) return
        val features = episode.features ?: return
        totals.classified++
        val decision = SnoreVerdict.decide(features, confirmer.band)
        val kind = if (SnoreVerdict.exceedsSnoreDuration(decision.kind, episode.durSec)) {
            SnoreVerdict.OTHER
        } else {
            decision.kind
        }
        totals.kinds[kind] = (totals.kinds[kind] ?: 0) + 1
        totals.episodeLines.add(describe(episode, kind))
        if (kind == SnoreVerdict.SNORE) {
            val outcome = confirmer.offer(candidate(episode, decision.snoreScore))
            for (snore in outcome.confirmed) totals.confirmedOnsets.add(snore.onset)
        }
    }

    private fun candidate(episode: EpisodeSegmenter.Episode, score: Int): SnoreConfirmer.Candidate {
        val candidate = SnoreConfirmer.Candidate()
        candidate.onset = episode.onset
        candidate.durSec = episode.durSec
        candidate.peak = episode.peak
        candidate.f0 = episode.features?.meanF0 ?: 0.0
        candidate.score = score
        return candidate
    }

    /**
     * Per-episode line. The six snoreScore terms are spelled out as a mask so a change can be
     * diffed term by term: guessing which one moved has been wrong three times running.
     * Upper case means the term passed. LB lowband, FL flat, PV per-or-voiced, ZC zcr,
     * F0 pitch in band, TP twoPeak, and LD lowDominant which gates the whole verdict.
     */
    private fun describe(episode: EpisodeSegmenter.Episode, kind: String): String {
        val f = episode.features
        return String.format(
            Locale.US,
            "t=%8.1f dur=%5.2f peak=%3d f0=%6.1f flat=%.3f zcr=%.3f %s %s",
            episode.onset, episode.durSec, episode.peak,
            f?.meanF0 ?: 0.0, f?.flat ?: 0.0, f?.zcr ?: 0.0, terms(f), kind,
        )
    }

    private fun terms(f: SnoreVerdict.Features?): String {
        if (f == null) return "-- -- -- -- -- --"
        val band = confirmer.band
        fun mark(on: Boolean, name: String) = if (on) name.uppercase() else name.lowercase()
        return listOf(
            mark(f.low + f.midLow > 0.60, "lb"),
            mark(f.flat < 0.35, "fl"),
            mark(f.periodicity > 0.45 || f.voicedFrac > 0.35, "pv"),
            mark(f.zcr < 0.18, "zc"),
            mark(f.meanF0 >= band.lo && f.meanF0 <= band.hi, "f0"),
            mark(f.peak200 > 0.08 && f.peak1k > 0.03, "tp"),
            mark(f.low >= 0.30 && f.low >= f.midLow * 0.8, "ld"),
        ).joinToString(" ")
    }
}
