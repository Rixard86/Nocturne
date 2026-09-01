package com.nocturne.replay

import java.io.File
import java.util.Locale
import kotlin.system.exitProcess

private const val DIVERGENCE_LIMIT = 20

object Report {

    fun print(file: File, t: ReplayTotals) {
        println()
        println("Replay  " + file.path)
        println()
        row("episodes logged", t.episodesLogged)
        row("  reached classifier", t.classified)
        row("  rejected before it", t.episodesLogged - t.classified)
        println()
        ratio("verdict reproduced", t.kindMatched to t.classified)
        ratio("gates + scores", t.gatesMatched to t.classified)
        println()
        println(String.format(Locale.US, "  %-22s %6d replayed  %6d logged",
            "confirmed snores", t.replayedSnores, t.loggedSnores))
        println()
        println("  replayed verdicts")
        for (entry in t.kinds.entries.sortedByDescending { it.value }) row("    " + entry.key, entry.value)
        printDivergences(t)
    }

    fun verdict(t: ReplayTotals): String = when {
        t.classified == 0 -> "no episodes to replay"
        t.replayedSnores != t.loggedSnores -> "DIVERGED: confirmed-snore count differs"
        t.divergences.isEmpty() -> "reproduced the recorded night exactly"
        t.edgeExplained == t.divergences.size ->
            "reproduced within the recording's precision (" +
                t.divergences.size + " divergences, all on a logged rounding edge)"
        else -> "DIVERGED from the recorded night"
    }

    fun passed(t: ReplayTotals): Boolean =
        t.classified > 0 &&
            t.replayedSnores == t.loggedSnores &&
            t.edgeExplained == t.divergences.size

    private fun printDivergences(t: ReplayTotals) {
        if (t.divergences.isEmpty()) return
        println()
        println(String.format(Locale.US, "  divergences (%d, %d on a rounding edge)",
            t.divergences.size, t.edgeExplained))
        for (line in t.divergences.take(DIVERGENCE_LIMIT)) println("    " + line)
        if (t.divergences.size > DIVERGENCE_LIMIT) {
            println("    ... " + (t.divergences.size - DIVERGENCE_LIMIT) + " more")
        }
    }

    private fun row(label: String, value: Int) =
        println(String.format(Locale.US, "  %-22s %6d", label, value))

    private fun ratio(label: String, hits: Pair<Int, Int>) =
        println(String.format(Locale.US, "  %-22s %6d / %d", label, hits.first, hits.second))
}

object RecordingReport {

    fun print(file: File, t: RecordingTotals) {
        println()
        println("Replay  " + file.path)
        println()
        row("reads replayed", t.chunks)
        println(String.format(Locale.US, "  %-22s %6.0f s", "audio", t.seconds))
        row("episodes", t.episodes)
        row("  reached classifier", t.classified)
        println()
        println(String.format(Locale.US, "  %-22s %6d", "confirmed snores", t.confirmedSnores))
        println()
        println("  verdicts")
        for (entry in t.kinds.entries.sortedByDescending { it.value }) row("    " + entry.key, entry.value)
    }

    private fun row(label: String, value: Int) =
        println(String.format(Locale.US, "  %-22s %6d", label, value))
}

/** Replay a recorded night from audio; returns the process exit code. */
private fun replayRecording(file: File, showAll: Boolean): Int {
    val recording = Recording()
    val problem = recording.open(file)
    if (problem != null) {
        println()
        println("  cannot read the recording: " + problem)
        return 2
    }
    val totals = RecordingReplay().run(recording)
    recording.close()
    RecordingReport.print(file, totals)
    if (showAll) {
        println()
        for (line in totals.episodeLines) println("  " + line)
        println()
        for (onset in totals.confirmedOnsets) println(String.format(Locale.US, "  CONFIRMED %.1f", onset))
    }
    return 0
}

fun main(args: Array<String>) {
    if (args.isEmpty()) {
        println("usage: replay <events.jsonl | night.wav> [--all]")
        exitProcess(2)
    }
    val file = File(args[0])
    if (!file.isFile) {
        println("no such file: " + file.path)
        exitProcess(2)
    }
    val showAll = args.contains("--all")
    if (file.extension.equals("wav", ignoreCase = true)) {
        exitProcess(replayRecording(file, showAll))
    }
    val totals = Replay().run(file, showAll)
    Report.print(file, totals)
    println()
    println("  " + Report.verdict(totals))
    if (!Report.passed(totals)) exitProcess(1)
}
