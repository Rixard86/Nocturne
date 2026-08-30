package com.nocturne.replay

/**
 * Minimal field reader for the diagnostic JSON lines the app writes.
 *
 * These lines are machine-generated with a fixed shape — flat, no nesting, no escapes in
 * the fields read here — so a scan for the key beats pulling in a JSON dependency.
 */
object JsonLine {

    fun string(line: String, key: String): String? {
        val at = valueStart(line, key) ?: return null
        if (at >= line.length || line[at] != '"') return null
        val end = line.indexOf('"', at + 1)
        return if (end < 0) null else line.substring(at + 1, end)
    }

    fun double(line: String, key: String): Double? {
        val at = valueStart(line, key) ?: return null
        var end = at
        while (end < line.length && line[end] != ',' && line[end] != '}') end++
        return line.substring(at, end).trim().toDoubleOrNull()
    }

    fun int(line: String, key: String): Int? = double(line, key)?.toInt()

    fun flag(line: String, key: String): Boolean = int(line, key) == 1

    private fun valueStart(line: String, key: String): Int? {
        val marker = "\"" + key + "\":"
        val at = line.indexOf(marker)
        return if (at < 0) null else at + marker.length
    }
}
