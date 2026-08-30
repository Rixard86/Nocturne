package com.nocturne.app

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.File

/**
 * Bridge between the web UI and the native AudioCaptureService.
 *
 * JS methods:
 *   start({ sensitivity })      -> begins the foreground service + capture
 *   stop()                      -> stops the service
 *   setSensitivity({ ratio })   -> updates detection ratio live
 *   isRunning()                 -> { running }
 *
 * Events pushed to JS (addListener):
 *   nocturneCalibrating { amp, secondsLeft }
 *   nocturneState       { state, amp, snoreCount, pauseCount, baseline }
 *   nocturneLevel       { level, snoring, elapsed, baseline }
 *   nocturneSample      { t, amp, level }
 *   nocturneSnore       { t, dur, level, count }
 *   nocturnePause       { t, dur, count }
 *   nocturneError       { message }
 */
@CapacitorPlugin(name = "Nocturne")
class NocturnePlugin : Plugin() {

    companion object {
        private var instance: NocturnePlugin? = null

        private fun emit(event: String, data: JSObject) {
            instance?.notifyListeners(event, data)
        }

        fun emitCalibrating(amp: Double, secondsLeft: Double) {
            emit("nocturneCalibrating", JSObject().put("amp", amp).put("secondsLeft", secondsLeft))
        }
        fun emitState(state: String, amp: Double, snoreCount: Int, pauseCount: Int, baseline: Double) {
            emit("nocturneState", JSObject()
                .put("state", state).put("amp", amp)
                .put("snoreCount", snoreCount).put("pauseCount", pauseCount)
                .put("baseline", baseline))
        }
        fun emitLevel(level: Int, snoring: Boolean, elapsed: Double, baseline: Double) {
            emit("nocturneLevel", JSObject().put("level", level).put("snoring", snoring).put("elapsed", elapsed).put("baseline", baseline))
        }
        fun emitSample(t: Double, amp: Double, level: Int) {
            emit("nocturneSample", JSObject().put("t", t).put("amp", amp).put("level", level))
        }
        fun emitSnore(t: Double, dur: Double, level: Int, count: Int, clipPath: String = "") {
            emit("nocturneSnore", JSObject().put("t", t).put("dur", dur).put("level", level).put("count", count).put("clip", clipPath))
        }
        fun emitSound(t: Double, dur: Double, level: Int, kind: String, count: Int) {
            emit("nocturneSound", JSObject().put("t", t).put("dur", dur).put("level", level).put("kind", kind).put("count", count))
        }
        fun emitPause(t: Double, dur: Double, count: Int, clipPath: String = "") {
            emit("nocturnePause", JSObject().put("t", t).put("dur", dur).put("count", count).put("clip", clipPath))
        }
        fun emitError(message: String) {
            emit("nocturneError", JSObject().put("message", message))
        }
        fun emitAlarm() {
            emit("nocturneAlarm", JSObject().put("fired", true))
        }
    }

    override fun load() {
        instance = this
    }

    private fun hasMicPermission(): Boolean {
        return ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED
    }

    @PluginMethod
    fun start(call: PluginCall) {
        if (!hasMicPermission()) {
            call.reject("microphone-permission-denied")
            return
        }
        val ratio = call.getDouble("sensitivity") ?: 1.4
        AudioCaptureService.sensitivityRatio = ratio
        val intent = Intent(context, AudioCaptureService::class.java)
        intent.putExtra(AudioCaptureService.EXTRA_SENSITIVITY, ratio)
        // smart alarm parameters (optional)
        if (call.getBoolean("alarmEnabled", false) == true) {
            intent.putExtra(AudioCaptureService.EXTRA_ALARM_ENABLED, true)
            intent.putExtra(AudioCaptureService.EXTRA_ALARM_TIME, call.getString("alarmTime") ?: "07:00")
            intent.putExtra(AudioCaptureService.EXTRA_ALARM_WINDOW, call.getInt("alarmWindowMin", 30))
        }
        // Must be started while the app is foreground (user tapped Record) — allowed.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(intent)
        } else {
            context.startService(intent)
        }
        call.resolve(JSObject().put("started", true))
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        val intent = Intent(context, AudioCaptureService::class.java)
        context.stopService(intent)
        call.resolve(JSObject().put("stopped", true))
    }

    @PluginMethod
    fun setSensitivity(call: PluginCall) {
        val ratio = call.getDouble("ratio") ?: 2.0
        AudioCaptureService.sensitivityRatio = ratio
        call.resolve()
    }

    @PluginMethod
    fun isRunning(call: PluginCall) {
        call.resolve(JSObject().put("running", AudioCaptureService.running))
    }

    @PluginMethod
    fun getState(call: PluginCall) {
        // A full night's log is 25k+ lines and over a megabyte. Parsing it and marshalling
        // it across the bridge takes seconds, and this runs on every launch — on the main
        // thread that is a grey screen before the UI appears. Do it off the main thread.
        Thread { call.resolve(buildState()) }.start()
    }

    /** Assemble the persisted session: { active, running, startMs, sensitivity, events }. */
    private fun buildState(): JSObject {
        val res = JSObject()
        res.put("running", AudioCaptureService.running)
        try {
            val dir = File(context.filesDir, "nocturne_session")
            val meta = File(dir, "session.json")
            var active = false; var startMs = 0L; var sens = 2.0
            if (meta.exists()) {
                val j = JSObject(meta.readText())
                // JSONObject.opt* return primitives with a default and never throw on a
                // missing key (unlike getBool/getDouble which don't exist / throw).
                active = j.optBoolean("active", false)
                startMs = j.optLong("startMs", 0L)
                sens = j.optDouble("sensitivity", 1.4)
            }
            res.put("active", active)
            res.put("startMs", startMs)
            res.put("sensitivity", sens)
            res.put("events", readSessionEvents(File(dir, "events.jsonl")))
        } catch (e: Exception) {
            res.put("active", false)
            res.put("events", com.getcapacitor.JSArray())
        }
        return res
    }

    // The UI reads only these four event types; "epi" / "rhythm" / "cfg" are diagnostics
    // for offline analysis and are pure weight across the bridge.
    private val uiEventTypes = setOf("sample", "snore", "sound", "pause")

    // Samples arrive once a second — 28,800 a night — but every consumer downsamples:
    // the timeline to 800 buckets, the hypnogram to 5-minute bins. Collapsing them here to
    // one per bucket keeps the loudest of each, which is what the charts would have kept.
    private val sampleBucketSec = 10.0

    /** Cheap scalar extraction, to avoid parsing 25k JSON objects just to bucket them. */
    private fun rawField(line: String, key: String): String? {
        val at = line.indexOf("\"$key\":")
        if (at < 0) return null
        val from = at + key.length + 3
        var to = from
        while (to < line.length && line[to] != ',' && line[to] != '}') to++
        return line.substring(from, to)
    }

    private fun isSample(line: String) = line.contains("\"e\":\"sample\"")

    private fun uiEventType(line: String): String? {
        val kind = rawField(line, "e")?.trim('"') ?: return null
        return if (kind in uiEventTypes) kind else null
    }

    /**
     * Read the session log, keeping every real event but only the loudest sample per
     * bucket. Returns the events the UI can actually use.
     */
    private fun readSessionEvents(log: File): com.getcapacitor.JSArray {
        val arr = com.getcapacitor.JSArray()
        if (!log.exists()) return arr
        var bucket = -1L
        var bestLine: String? = null
        var bestLevel = -1

        fun flush() {
            bestLine?.let { line -> runCatching { arr.put(JSObject(line)) } }
            bestLine = null; bestLevel = -1
        }

        log.forEachLine { raw ->
            val line = raw.trim()
            if (line.isNotEmpty() && uiEventType(line) != null) {
                if (!isSample(line)) {
                    runCatching { arr.put(JSObject(line)) }
                } else {
                    val at = rawField(line, "t")?.toDoubleOrNull() ?: 0.0
                    val level = rawField(line, "lvl")?.toIntOrNull() ?: 0
                    val slot = (at / sampleBucketSec).toLong()
                    if (slot != bucket) { flush(); bucket = slot }
                    if (level > bestLevel) { bestLevel = level; bestLine = line }
                }
            }
        }
        flush()
        return arr
    }

    /**
     * Retire the persisted session once the UI has finalized it. Without this the log
     * outlives the night that produced it, and every subsequent cold launch recovers and
     * re-finalizes the same recording, stamping each copy with the launch time.
     *
     * The log is ARCHIVED rather than deleted: it is the only diagnostic record of the
     * night, and it is normally pulled the morning after — which is exactly when this
     * runs. Recovery reads events.jsonl, so moving it aside is enough to stop the loop.
     */
    @PluginMethod
    fun clearSession(call: PluginCall) {
        try {
            val dir = File(context.filesDir, "nocturne_session")
            val log = File(dir, "events.jsonl")
            if (log.exists()) {
                val archive = File(dir, "events-last.jsonl")
                archive.delete()
                if (!log.renameTo(archive)) log.delete()
            }
            File(dir, "session.json").delete()
        } catch (_: Exception) {}
        call.resolve()
    }

    @PluginMethod
    fun requestIgnoreBatteryOptimizations(call: PluginCall) {
        try {
            val pm = context.getSystemService(android.content.Context.POWER_SERVICE) as android.os.PowerManager
            val pkg = context.packageName
            if (pm.isIgnoringBatteryOptimizations(pkg)) {
                call.resolve(JSObject().put("alreadyExempt", true)); return
            }
            val intent = Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
                .setData(android.net.Uri.parse("package:$pkg"))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
            call.resolve(JSObject().put("requested", true))
        } catch (e: Exception) {
            call.reject("battery-optimization-request-failed", e)
        }
    }

    @PluginMethod
    fun isIgnoringBatteryOptimizations(call: PluginCall) {
        try {
            val pm = context.getSystemService(android.content.Context.POWER_SERVICE) as android.os.PowerManager
            call.resolve(JSObject().put("ignoring", pm.isIgnoringBatteryOptimizations(context.packageName)))
        } catch (e: Exception) {
            call.resolve(JSObject().put("ignoring", false))
        }
    }
}
