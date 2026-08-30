package com.nocturne.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.RingtoneManager
import android.media.audiofx.AutomaticGainControl
import android.media.audiofx.NoiseSuppressor
import android.net.Uri
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.os.VibrationEffect
import android.os.Vibrator
import androidx.core.app.NotificationCompat
import org.json.JSONObject
import java.io.File
import java.util.Locale
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.Calendar
import kotlin.math.log2
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

/**
 * Foreground service that records audio via AudioRecord and runs snore / breathing-pause
 * detection natively, so it keeps working with the screen off. Detection mirrors the
 * JavaScript logic: an initial room-baseline calibration, an adaptive quiet floor, a
 * sensitivity-driven ratio for snore events, and a loud-then-long-silence pause flag.
 *
 * Results are pushed to the JS layer through NocturnePlugin's static event bridge.
 */
class AudioCaptureService : Service() {

    companion object {
        const val CHANNEL_ID = "nocturne_capture"
        const val ALARM_CHANNEL_ID = "nocturne_alarm"
        const val NOTIF_ID = 4711
        const val ALARM_NOTIF_ID = 4712
        const val EXTRA_SENSITIVITY = "sensitivity"
        const val EXTRA_ALARM_ENABLED = "alarm_enabled"
        const val EXTRA_ALARM_TIME = "alarm_time"
        const val EXTRA_ALARM_WINDOW = "alarm_window"
        const val EXTRA_RAW_CAPTURE = "raw_capture"
        const val SESSION_DIR_NAME = "nocturne_session"
        const val SESSION_META_NAME = "session.json"
        @Volatile var running = false
        @Volatile var sensitivityRatio = 1.4   // auto wake-gate; updated live from the plugin
    }

    private var thread: Thread? = null
    @Volatile private var stopRequested = false

    // detection state
    private val segmenter = EpisodeSegmenter()
    private var startMs = 0L              // when the NIGHT began (survives a restart)
    private var captureStartMs = 0L       // when this capture run began
    private var sessionOffsetSec = 0.0    // seconds of the night already recorded before this run
    private var resumedSession = false
    private var resumedStartMs = 0L
    private var wakeLock: PowerManager.WakeLock? = null
    // silence-based pause tracking (apnea = true silence after a snore episode)
    private var silentSinceMs = 0L
    private var lastEpLoudMs = 0L
    private var lastEpDurSec = 0.0
    private var movementCount = 0
    private var otherCount = 0
    private var lastSampleMs = 0L
    private var snoreCount = 0
    private var pauseCount = 0
    private val silenceFactor = 1.2       // amp below baseline x this counts as true silence
    private val minPauseSec = 9.0
    private val maxPauseSec = 60.0
    private val minSnoreBeforePauseSec = 2.0
    private val pauseSlackSec = 2.0       // the pause may start just before the episode ends
    private val maxSincePauseSec = 20.0

    private val readIdleMs = 10L          // brief pause on an empty read, so we never hot-spin
    private val silentStreamAmp = 1e-6    // below this the stream is digital silence, not a quiet room
    private val silentReadsBeforeWarning = 600  // ~1 min of silence before telling the user
    private var silentReads = 0
    private val activeEffects = ArrayList<android.media.audiofx.AudioEffect>()
    private val maxSessionMs = 12 * 3600_000L  // hard cap: auto-stop a forgotten recording after 12h

    // ---- overnight session persistence (survives a WebView/UI kill) ----
    // Events are appended to a JSON-lines file as they occur, and a small session file
    // records start time + running flag. On relaunch the UI reads these via getState()
    // and rebuilds the night, so an OS-killed WebView doesn't lose the recording.
    private var sessionDir: File? = null
    private var sessionLog: File? = null
    private val sessionLock = Any()

    private fun jsonStr(s: String): String {
        val sb = StringBuilder("\"")
        for (c in s) when (c) {
            '\\' -> sb.append("\\\\"); '"' -> sb.append("\\\"")
            '\n' -> sb.append("\\n"); '\r' -> sb.append("\\r"); '\t' -> sb.append("\\t")
            else -> sb.append(c)
        }
        sb.append("\""); return sb.toString()
    }

    private fun appendSessionEvent(line: String) {
        val f = sessionLog ?: return
        synchronized(sessionLock) {
            try { FileOutputStream(f, true).use { it.write((line + "\n").toByteArray()) } } catch (_: Exception) {}
        }
    }
    private fun writeSessionMeta(active: Boolean) {
        val dir = sessionDir ?: return
        try {
            File(dir, SESSION_META_NAME).writeText(
                "{\"active\":$active,\"startMs\":$startMs,\"sensitivity\":$sensitivityRatio" +
                    ",\"rawCapture\":$rawCaptureEnabled,\"alarmEnabled\":$alarmEnabled" +
                    ",\"alarmDeadlineMs\":$alarmDeadlineMs,\"alarmWindowStartMs\":$alarmWindowStartMs" +
                    ",\"alarmFired\":$alarmFired}")
        } catch (_: Exception) {}
    }

    // debug tap: record the night to disk so it can be replayed through the detector
    private var rawCaptureEnabled = false
    private var rawCapture: RawCapture? = null

    // audio clip capture for the current episode (real snore audio for playback).
    // One reusable buffer with a write cursor: an ArrayList<Short> boxed every sample,
    // roughly 441,000 objects per episode, for every blip above the gate all night.
    private var clipBuf = ShortArray(0)
    private var clipLen = 0
    private var clipActive = false
    private var clipSampleRate = 44100
    private val clipMaxSamples get() = clipSampleRate * 10  // cap clip at ~10s
    private val clipRetentionMs = 7L * 24 * 60 * 60 * 1000  // keep clips ~7 days, then prune by age
    private var clipsDir: File? = null

    // rolling ring buffer of recent DECIMATED audio, so a breathing pause can be saved
    // with context (the snore before, the silence, and the gasp after). Decimated to
    // keep memory small: ~45s at 8820 Hz ≈ 400k shorts ≈ 800 KB.
    private var ringRate = 8820
    private val ringSeconds = 45
    private var ring: ShortArray = ShortArray(0)
    private var ringPos = 0          // next write index (circular)
    private var ringFilled = 0       // how many valid samples are in the ring
    private var pauseSilenceStartMs = 0L  // wall-clock when the current silence began

    // smart alarm
    private var alarmEnabled = false
    private var alarmDeadlineMs = 0L      // absolute time by which we must wake
    private var alarmWindowStartMs = 0L   // earliest time we may wake at a light moment
    private var alarmFired = false
    // recent level history for a light-sleep decision (short-window restlessness)
    private val recentLevels = ArrayDeque<Int>()

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // A null Intent means the system restarted us after a process kill (START_STICKY).
        // Taking the defaults there would silently change detection mid-night and turn the
        // smart alarm and raw capture off, so the session's own settings are restored.
        if (intent == null) restoreSession() else applyStartOptions(intent)
        startForegroundWithNotification()
        if (!running) {
            running = true
            stopRequested = false
            thread = Thread { runCapture() }.also { it.start() }
        }
        return START_STICKY
    }

    private fun applyStartOptions(intent: Intent) {
        resumedSession = false
        sensitivityRatio = intent.getDoubleExtra(EXTRA_SENSITIVITY, 1.4)
        rawCaptureEnabled = intent.getBooleanExtra(EXTRA_RAW_CAPTURE, false)
        // parse smart-alarm config
        alarmEnabled = intent.getBooleanExtra(EXTRA_ALARM_ENABLED, false)
        if (alarmEnabled) {
            computeAlarmWindow(
                intent.getStringExtra(EXTRA_ALARM_TIME) ?: "07:00",
                intent.getIntExtra(EXTRA_ALARM_WINDOW, 30),
            )
            alarmFired = false
        }
    }

    /**
     * Reload a session the system interrupted, so the night continues instead of starting
     * over. The alarm is restored as absolute times rather than re-parsed, which would roll
     * the target to the next day.
     */
    private fun restoreSession() {
        resumedSession = false
        val meta = File(File(filesDir, SESSION_DIR_NAME), SESSION_META_NAME)
        if (!meta.isFile) return
        try {
            val saved = JSONObject(meta.readText())
            if (!saved.optBoolean("active", false)) return
            val savedStart = saved.optLong("startMs", 0L)
            if (savedStart <= 0L) return
            resumedStartMs = savedStart
            sensitivityRatio = saved.optDouble("sensitivity", 1.4)
            rawCaptureEnabled = saved.optBoolean("rawCapture", false)
            alarmEnabled = saved.optBoolean("alarmEnabled", false)
            alarmDeadlineMs = saved.optLong("alarmDeadlineMs", 0L)
            alarmWindowStartMs = saved.optLong("alarmWindowStartMs", 0L)
            alarmFired = saved.optBoolean("alarmFired", false)
            resumedSession = true
        } catch (_: Exception) {}
    }

    /** Run the capture loop so an uncaught throw cannot kill the process without a trace. */
    private fun runCapture() {
        try {
            captureLoop()
        } catch (t: Throwable) {
            NocturnePlugin.emitError("Capture stopped: ${t.javaClass.simpleName}")
            appendSessionEvent("{\"e\":\"capture\",\"fatal\":${jsonStr(t.toString())}}")
            writeSessionMeta(false)
        } finally {
            running = false
        }
    }

    override fun onDestroy() {
        stopRequested = true
        running = false
        try { thread?.join(500) } catch (_: InterruptedException) {}
        activeEffects.forEach { runCatching { it.release() } }
        activeEffects.clear()
        writeSessionMeta(false)   // recording ended; UI should finalize, not re-attach
        super.onDestroy()
    }

    private fun startForegroundWithNotification() {
        val nm = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val ch = NotificationChannel(
                CHANNEL_ID, "Sleep monitoring",
                NotificationManager.IMPORTANCE_LOW
            ).apply { setShowBadge(false) }
            nm.createNotificationChannel(ch)
        }
        val notif: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Nocturne is listening")
            .setContentText("Monitoring your sleep for snoring and pauses")
            .setSmallIcon(applicationInfo.icon)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
        } else {
            startForeground(NOTIF_ID, notif)
        }
    }

    private fun captureLoop() {
        val sampleRate = 44100
        val minBuf = AudioRecord.getMinBufferSize(
            sampleRate,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT
        )
        val bufSize = max(minBuf, sampleRate / 10) // ~100ms chunks
        // Prefer an unprocessed capture path: AGC / noise-suppression on the default MIC
        // source distort the low-frequency spectra the classifier relies on. UNPROCESSED
        // is ideal but not on every device, so fall back to VOICE_RECOGNITION then MIC.
        fun buildRecorder(source: Int): AudioRecord? = try {
            val r = AudioRecord(source, sampleRate, AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT, bufSize)
            if (r.state == AudioRecord.STATE_INITIALIZED) r else { r.release(); null }
        } catch (se: SecurityException) { throw se } catch (e: Exception) { null }

        var sourceName = "none"
        fun named(source: Int, name: String): AudioRecord? =
            buildRecorder(source)?.also { sourceName = name }

        // Source preference, in order. UNPROCESSED is theoretically ideal (no AGC, no
        // filtering) but on some devices it is also drastically lower gain: measured on a
        // Galaxy S21 it idled at 0.66 LSB and peaked at 56 LSB across a whole night — 55 dB
        // below full scale, leaving the spectral features measuring quantization noise.
        // VOICE_RECOGNITION gives usable gain, and the effects it would normally apply are
        // switched off explicitly below. Reorder this list to A/B the paths; the chosen one
        // is recorded in the session log's "cfg" line.
        val recorder = try {
            named(MediaRecorder.AudioSource.VOICE_RECOGNITION, "VOICE_RECOGNITION")
                ?: (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N)
                    named(MediaRecorder.AudioSource.UNPROCESSED, "UNPROCESSED") else null)
                ?: named(MediaRecorder.AudioSource.MIC, "MIC")
        } catch (e: SecurityException) {
            NocturnePlugin.emitError("Microphone permission denied")
            stopSelf(); return
        }

        if (recorder == null || recorder.state != AudioRecord.STATE_INITIALIZED) {
            NocturnePlugin.emitError("AudioRecord failed to initialize")
            stopSelf(); return
        }

        val buffer = ShortArray(bufSize)
        silentReads = 0
        captureStartMs = System.currentTimeMillis()
        // On a resume the night keeps its original start, so episode onsets and the elapsed
        // clock stay on one timeline across the interruption.
        startMs = if (resumedSession) resumedStartMs else captureStartMs
        sessionOffsetSec = (captureStartMs - startMs) / 1000.0
        segmenter.begin(sampleRate / AcousticFeatures.DECIM_FACTOR, captureStartMs)
        clipSampleRate = sampleRate
        clipsDir = File(filesDir, "snore_clips").apply { mkdirs() }
        // Clips live in filesDir (not cacheDir) so they survive storage-pressure eviction
        // and stay playable when you reopen a recent night's report. Rather than wiping
        // every session, prune anything past the retention window; this also clears
        // orphaned unconfirmed-candidate files once they age out.
        pruneOldClips()
        // size the rolling ring buffer for pause context
        ringRate = sampleRate / AcousticFeatures.DECIM_FACTOR
        ring = ShortArray(ringRate * ringSeconds)
        ringPos = 0; ringFilled = 0
        // the persisted session for overnight re-attach. On a resume the log is KEPT: deleting
        // it would throw away the hours already recorded and restamp the night's start.
        sessionDir = File(filesDir, SESSION_DIR_NAME).apply { mkdirs() }
        sessionLog = File(sessionDir, "events.jsonl").apply {
            if (!resumedSession) runCatching { if (exists()) delete() }
        }
        writeSessionMeta(true)
        if (resumedSession) {
            appendSessionEvent("{\"e\":\"resume\",\"t\":${"%.1f".format(Locale.US, sessionOffsetSec)}}")
        }
        val recordingDir = sessionDir
        rawCapture = if (rawCaptureEnabled && recordingDir != null) {
            RawCapture(startMs, sensitivityRatio)
                .apply { resume = resumedSession }
                .takeIf { it.open(recordingDir, sampleRate / AcousticFeatures.DECIM_FACTOR) }
        } else {
            null
        }
        if (rawCaptureEnabled) {
            appendSessionEvent("{\"e\":\"raw\",\"on\":${rawCapture != null}}")
        }
        acquireWakeLock()

        // AGC and noise suppression are tuned for speech: they flatten exactly the sustained
        // low-frequency energy the snore classifier keys on, and AGC lifts the measured floor
        // during inter-breath silences. Turn both off where the device exposes them.
        val rates = EpisodeLog.CaptureRates(sampleRate, minBuf, buffer.size)
        rates.device = "${Build.MANUFACTURER} ${Build.MODEL} api${Build.VERSION.SDK_INT}"
        rates.agc = disableEffect("agc", recorder.audioSessionId)
        rates.noiseSuppressor = disableEffect("ns", recorder.audioSessionId)

        recorder.startRecording()
        appendSessionEvent(EpisodeLog.config(sourceName, rates))
        NocturnePlugin.emitState("calibrating", 0.0, 0, 0, 0.0)

        val chunk = EpisodeSegmenter.Chunk()
        try {
        while (!stopRequested) {
            val read = recorder.read(buffer, 0, buffer.size)
            if (read < 0) {
                // ERROR_DEAD_OBJECT / ERROR_INVALID_OPERATION: the stream is gone. Spinning
                // here burns a core all night while the UI still shows a healthy recording,
                // so fail loudly instead.
                NocturnePlugin.emitError("Audio stream lost (code $read)")
                appendSessionEvent("{\"e\":\"capture\",\"err\":$read}")
                break
            }
            if (read == 0) { Thread.sleep(readIdleMs); continue }
            val now = System.currentTimeMillis()

            // morning safety net: a recording left running for 12h+ auto-stops so it
            // doesn't run all day and drain the battery if the user forgets to tap stop.
            // (The state event is emitted AFTER the post-loop flush, so the final
            // episode/pause events reach the UI before it tears down its listeners.)
            if (now - startMs > maxSessionMs) break

            val snoreRatio = sensitivityRatio
            segmenter.sensitivityRatio = snoreRatio
            chunk.samples = buffer
            chunk.length = read
            chunk.atMs = now
            chunk.amp = rms(buffer, read)
            rawCapture?.append(chunk)
            val wasActive = segmenter.active
            val reading = segmenter.accept(chunk)
            trackSilentStream(reading.amp)

            if (reading.calibrating) {
                NocturnePlugin.emitCalibrating(reading.amp, reading.calibLeftSec)
                if (reading.calibrationComplete) {
                    NocturnePlugin.emitState("listening", reading.amp, snoreCount, pauseCount, reading.baseline)
                }
                continue
            }

            val elapsed = (now - startMs) / 1000.0
            feedRing(buffer, read)

            // downsampled ~1s sample for the timeline
            if (lastSampleMs == 0L || now - lastSampleMs > 1000) {
                lastSampleMs = now
                NocturnePlugin.emitSample(elapsed, reading.amp, reading.level)
                // Scientific notation: a quiet room on a low-gain path idles near 1e-5,
                // where %.5f rounds everything to a single significant figure and hides
                // exactly the detail needed to tell a tracking floor from a clamped one.
                appendSessionEvent("{\"e\":\"sample\",\"t\":${"%.1f".format(Locale.US, elapsed)},\"amp\":${"%.3e".format(Locale.US, reading.amp)},\"base\":${"%.3e".format(Locale.US, reading.baseline)},\"lvl\":${reading.level}}")
            }

            // smart alarm: within the wake window, fire at a light-sleep moment;
            // at the hard deadline, fire regardless.
            if (alarmEnabled && !alarmFired) {
                recentLevels.addLast(reading.level)
                while (recentLevels.size > 30) recentLevels.removeFirst()  // ~30 reads window
                val past = System.currentTimeMillis()
                if (past >= alarmDeadlineMs) {
                    triggerAlarm()
                } else if (past >= alarmWindowStartMs && isLightSleepNow()) {
                    triggerAlarm()
                }
            }

            if (reading.episodeStarted) startClip()
            if (wasActive || reading.episodeStarted) appendClip(buffer, read)
            reading.finalized?.let { handleEpisode(it) }
            trackPause(reading, now)

            NocturnePlugin.emitLevel(reading.level, reading.ratio > snoreRatio, elapsed, reading.baseline)
        }

        // flush a snore episode still open when recording stops
        segmenter.flush()?.let { handleEpisode(it) }
        // flush a pause still open at stop (silence continued to the end)
        if (silentSinceMs != 0L) closePause(System.currentTimeMillis())
        } finally {
            // always run: a throw here would otherwise leak the recorder and the wake lock,
            // and leave the recording without its patched header
            rawCapture?.close()
            rawCapture = null
            try { recorder.stop() } catch (_: Exception) {}
            recorder.release()
            releaseWakeLock()
        }

        // if we exited the loop on our own (12h cap) rather than a user stop, mark the
        // session ended and shut down — emitted AFTER the flush so no events are lost.
        if (!stopRequested) {
            writeSessionMeta(false)
            running = false
            NocturnePlugin.emitState("auto-stopped", 0.0, snoreCount, pauseCount, segmenter.currentBaseline)
            stopSelf()
        }
    }

    /**
     * Close the open episode: classify it acoustically, then confirm snores by RHYTHM.
     *
     * The research is explicit that periodicity across episodes is the decisive cue and
     * the main defense against false positives: a lone voiced burst (a grunt, a word of
     * sleep-talk) should not count, but a burst that is one of a 2-6 s train almost
     * certainly is snoring. So a snore-like episode is held as "pending" until a second
     * episode arrives close in time; matching onsets 2-6 s apart confirm BOTH. Snore F0
     * is also accumulated to calibrate the classifier to this user's own pitch.
     */
    private fun startClip() {
        if (clipBuf.size < clipMaxSamples) clipBuf = ShortArray(clipMaxSamples)
        clipLen = 0
        clipActive = true
    }

    /** Accumulate the open episode's full-rate audio, for snore playback. */
    private fun appendClip(buf: ShortArray, len: Int) {
        if (!clipActive || clipLen >= clipMaxSamples) return
        val take = min(len, clipMaxSamples - clipLen)
        System.arraycopy(buf, 0, clipBuf, clipLen, take)
        clipLen += take
    }

    private fun rms(buf: ShortArray, len: Int): Double {
        var sum = 0.0
        for (i in 0 until len) {
            val v = buf[i] / 32768.0
            sum += v * v
        }
        return sqrt(sum / len)
    }

    /**
     * Hold the CPU awake for the session. AudioFlinger usually keeps it up on its own, so
     * this is belt-and-braces — but the permission is declared, and a stalled night costs
     * the whole night. The timeout means a leaked lock cannot drain the battery all day.
     */
    private fun acquireWakeLock() {
        if (wakeLock != null) return
        try {
            val power = getSystemService(POWER_SERVICE) as PowerManager
            wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "nocturne:capture").apply {
                setReferenceCounted(false)
                acquire(maxSessionMs)
            }
        } catch (_: Exception) {}
    }

    private fun releaseWakeLock() {
        try { wakeLock?.let { if (it.isHeld) it.release() } } catch (_: Exception) {}
        wakeLock = null
    }

    /** Feed the rolling ring buffer with decimated audio, for breathing-pause context. */
    private fun feedRing(buf: ShortArray, len: Int) {
        if (ring.isEmpty()) return
        var i = 0
        val factor = AcousticFeatures.DECIM_FACTOR
        while (i + factor <= len) {
            var sum = 0
            for (k in 0 until factor) sum += buf[i + k]
            ring[ringPos] = (sum / factor).toShort()
            ringPos = (ringPos + 1) % ring.size
            if (ringFilled < ring.size) ringFilled++
            i += factor
        }
    }

    /**
     * Breathing-pause / apnea flag — near-TOTAL silence (well below breathing sounds),
     * 9-60s long, following a genuine snore episode (>=2s). Measured when sound resumes so
     * the recorded duration is the real gap length. Quiet breathing stays above the silence
     * floor and no longer counts.
     */
    private fun trackPause(reading: EpisodeSegmenter.Reading, atMs: Long) {
        if (reading.amp < reading.baseline * silenceFactor) {
            if (silentSinceMs == 0L) silentSinceMs = atMs
            return
        }
        if (silentSinceMs != 0L) closePause(atMs)
    }

    private fun closePause(atMs: Long) {
        val gap = (atMs - silentSinceMs) / 1000.0
        val sinceEp = if (lastEpLoudMs != 0L) (silentSinceMs - lastEpLoudMs) / 1000.0 else Double.MAX_VALUE
        if (gap in minPauseSec..maxPauseSec && lastEpDurSec >= minSnoreBeforePauseSec &&
            sinceEp in -pauseSlackSec..maxSincePauseSec) {
            pauseCount++
            // save context audio: from ~3s before the silence began, through the silence,
            // to now (the gasp/resumption). Read from the ring.
            val path = writePauseClip(silentSinceMs, atMs)
            val pt = (silentSinceMs - startMs) / 1000.0
            NocturnePlugin.emitPause(pt, gap, pauseCount, path)
            appendSessionEvent("{\"e\":\"pause\",\"t\":${"%.1f".format(Locale.US, pt)},\"dur\":${"%.1f".format(Locale.US, gap)},\"count\":$pauseCount,\"clip\":${jsonStr(path)}}")
        }
        silentSinceMs = 0L
    }

    /**
     * Close a finalized episode: gate it, classify it, route it, and always log why it was
     * or wasn't accepted.
     */
    private fun handleEpisode(episode: EpisodeSegmenter.Episode) {
        val record = EpisodeLog.EpisodeRecord()
        record.onset = episode.onset + sessionOffsetSec
        record.durSec = episode.durSec
        record.peak = episode.peak
        record.baseline = episode.baseline
        record.frames = episode.frames
        var features: SnoreVerdict.Features? = null

        if (episode.durSec <= EpisodeSegmenter.MIN_EPISODE_DUR_SEC) {
            record.reject = EpisodeLog.REASON_SHORT
        } else if (episode.peak < EpisodeSegmenter.MIN_EPISODE_PEAK) {
            record.reject = EpisodeLog.REASON_QUIET
        } else {
            // classify using the (possibly calibrated) per-user F0 band
            features = episode.features
            routeEpisode(record, features)
        }
        if (episode.forced) record.reject = EpisodeLog.REASON_MAX_EPISODE
        appendSessionEvent(EpisodeLog.episode(record, features))
        clipActive = false
        clipLen = 0
    }

    /** Take the verdict for a classified episode and send it down the snore or sound path. */
    private fun routeEpisode(record: EpisodeLog.EpisodeRecord, features: SnoreVerdict.Features?) {
        record.kind = verdictFor(record, features)
        // Continuous sound is not breathing, however snore-like its spectrum. It is
        // still emitted as a sound so it stays visible rather than vanishing.
        val tooLong = record.cappedForDuration
        if (record.kind == SnoreVerdict.SNORE) {
            // snore-LIKE: hold as pending, confirm by rhythm against the last snore/pending
            handleSnoreCandidate(snoreCandidate(record, writeClip()))
            return
        }
        record.reject = if (tooLong) EpisodeLog.REASON_TOO_LONG
                        else EpisodeLog.REASON_NOT_SNORE + record.kind
        if (record.kind == SnoreVerdict.MOVEMENT) movementCount++ else otherCount++
        NocturnePlugin.emitSound(record.onset, record.durSec, record.peak, record.kind,
            if (record.kind == SnoreVerdict.MOVEMENT) movementCount else otherCount)
        appendSessionEvent("{\"e\":\"sound\",\"t\":${"%.1f".format(Locale.US, record.onset)},\"dur\":${"%.2f".format(Locale.US, record.durSec)},\"lvl\":${record.peak},\"kind\":\"${record.kind}\"}")
    }

    /** Decide the episode, recording the gates on it, and apply the duration cap. */
    private fun verdictFor(record: EpisodeLog.EpisodeRecord, features: SnoreVerdict.Features?): String {
        if (features == null) return SnoreVerdict.OTHER
        val decision = SnoreVerdict.decide(features, confirmer.band)
        record.lowDominant = decision.lowDominant
        record.twoPeak = decision.twoPeak
        record.steadyNoise = decision.steadyNoise
        record.snoreScore = decision.snoreScore
        record.movementScore = decision.movementScore
        record.meanF0 = features.meanF0
        record.cappedForDuration = SnoreVerdict.exceedsSnoreDuration(decision.kind, record.durSec)
        return if (record.cappedForDuration) SnoreVerdict.OTHER else decision.kind
    }

    // ---- rhythm confirmation + F0 calibration ----
    private val confirmer = SnoreConfirmer()

    /** Record which branch the rhythm gate took, so a night of misses is diagnosable. */
    private fun logRhythm(candidate: SnoreConfirmer.Candidate, outcome: SnoreConfirmer.Outcome) {
        val gaps = EpisodeLog.RhythmGaps(outcome.gapFromConfirmed, outcome.gapFromPending)
        appendSessionEvent(EpisodeLog.rhythm(candidate.onset, gaps, outcome.branch))
    }

    /** Package the episode being finalized as a candidate for the rhythm gate. */
    private fun snoreCandidate(record: EpisodeLog.EpisodeRecord, clipPath: String): SnoreConfirmer.Candidate {
        val candidate = SnoreConfirmer.Candidate()
        candidate.onset = record.onset
        candidate.durSec = record.durSec
        candidate.peak = record.peak
        candidate.clip = clipPath
        candidate.f0 = record.meanF0
        return candidate
    }

    private fun handleSnoreCandidate(candidate: SnoreConfirmer.Candidate) {
        val outcome = confirmer.offer(candidate)
        logRhythm(candidate, outcome)
        for (snore in outcome.confirmed) emitConfirmedSnore(snore)
    }

    private fun emitConfirmedSnore(snore: SnoreConfirmer.Candidate) {
        snoreCount++
        NocturnePlugin.emitSnore(snore.onset, snore.durSec, snore.peak, snoreCount, snore.clip)
        appendSessionEvent("{\"e\":\"snore\",\"t\":${"%.1f".format(Locale.US, snore.onset)},\"dur\":${"%.2f".format(Locale.US, snore.durSec)},\"lvl\":${snore.peak},\"count\":$snoreCount,\"clip\":${jsonStr(snore.clip)}}")
        lastEpLoudMs = startMs + (snore.onset * 1000).toLong() + (snore.durSec * 1000).toLong()
        lastEpDurSec = snore.durSec
    }

    /**
     * Turn off a speech-oriented audio effect for this capture session.
     * Returns what happened, for the config log: these effects materially change the
     * spectrum, and knowing which ones were active is the difference between a
     * reproducible night and a mystery.
     */
    private fun disableEffect(kind: String, sessionId: Int): String = try {
        val available = if (kind == "agc") AutomaticGainControl.isAvailable()
                        else NoiseSuppressor.isAvailable()
        if (!available) "unavailable" else {
            val effect = if (kind == "agc") AutomaticGainControl.create(sessionId)
                         else NoiseSuppressor.create(sessionId)
            if (effect == null) "unavailable" else {
                effect.enabled = false
                activeEffects.add(effect)
                "disabled"
            }
        }
    } catch (e: Exception) { "error" }

    /**
     * Watch for a stream that reads successfully but returns digital silence — what happens
     * when a call, another app, or the privacy mute takes the microphone. Without this the
     * night looks perfectly healthy while nothing can possibly be detected.
     */
    private fun trackSilentStream(amp: Double) {
        if (amp > silentStreamAmp) { silentReads = 0; return }
        silentReads++
        if (silentReads == silentReadsBeforeWarning) {
            NocturnePlugin.emitError("Microphone is returning silence — check if another app took it")
            appendSessionEvent("{\"e\":\"capture\",\"silent\":$silentReads}")
        }
    }



    /** Compute the absolute wake window [start, deadline] from an HH:MM target + window minutes. */
    private fun computeAlarmWindow(hhmm: String, windowMin: Int) {
        val parts = hhmm.split(":")
        val hour = parts.getOrNull(0)?.toIntOrNull() ?: 7
        val minute = parts.getOrNull(1)?.toIntOrNull() ?: 0
        val cal = Calendar.getInstance().apply {
            set(Calendar.HOUR_OF_DAY, hour)
            set(Calendar.MINUTE, minute)
            set(Calendar.SECOND, 0)
            set(Calendar.MILLISECOND, 0)
        }
        // if the target time has already passed today, schedule for tomorrow
        if (cal.timeInMillis <= System.currentTimeMillis()) {
            cal.add(Calendar.DAY_OF_MONTH, 1)
        }
        alarmDeadlineMs = cal.timeInMillis
        alarmWindowStartMs = alarmDeadlineMs - windowMin * 60_000L
    }

    /** Light sleep proxy: recent movement/restlessness is elevated (higher level variance),
     *  which correlates acoustically with lighter sleep — a good moment to wake. */
    private fun isLightSleepNow(): Boolean {
        if (recentLevels.size < 15) return false
        val mean = recentLevels.average()
        val variance = recentLevels.map { (it - mean) * (it - mean) }.average()
        val sd = sqrt(variance)
        // restless/light if there's audible movement variability or a raised mean level
        return sd > 7.0 || mean > 12.0
    }

    private fun triggerAlarm() {
        alarmFired = true
        val nm = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val ch = NotificationChannel(
                ALARM_CHANNEL_ID, "Smart alarm",
                NotificationManager.IMPORTANCE_HIGH
            )
            val alarmUri: Uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
                ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
            val attrs = AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ALARM)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build()
            ch.setSound(alarmUri, attrs)
            ch.enableVibration(true)
            nm.createNotificationChannel(ch)
        }
        val notif = NotificationCompat.Builder(this, ALARM_CHANNEL_ID)
            .setContentTitle("Good morning")
            .setContentText("Nocturne woke you at a light-sleep moment")
            .setSmallIcon(applicationInfo.icon)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setAutoCancel(true)
            .setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM))
            .build()
        nm.notify(ALARM_NOTIF_ID, notif)
        // vibrate
        try {
            val vib = getSystemService(Vibrator::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                vib.vibrate(VibrationEffect.createWaveform(longArrayOf(0, 500, 300, 500, 300, 500), -1))
            } else {
                @Suppress("DEPRECATION") vib.vibrate(longArrayOf(0, 500, 300, 500, 300, 500), -1)
            }
        } catch (_: Exception) {}
        NocturnePlugin.emitAlarm()
    }

    /** Delete snore/pause clips older than the retention window (age-based pruning). */
    private fun pruneOldClips() {
        val dir = clipsDir ?: return
        val cutoff = System.currentTimeMillis() - clipRetentionMs
        dir.listFiles()?.forEach { f ->
            if (f.lastModified() < cutoff) runCatching { f.delete() }
        }
    }

    /** Write an episode's PCM samples (at clipSampleRate) to a WAV; returns path or "". */
    private fun writeClip(): String {
        if (!clipActive || clipLen == 0) return ""
        return writeWav(clipBuf.copyOf(clipLen), clipSampleRate, "snore_${System.currentTimeMillis()}_0.wav")
    }

    /**
     * Save a breathing-pause clip with context from the rolling ring buffer: from ~3s
     * before the silence began (the preceding snore) through to the resumption (the gasp).
     * The ring holds decimated audio, so this is written at ringRate. Capped at ~20s.
     */
    private fun writePauseClip(silenceStartMs: Long, endMs: Long): String {
        if (ring.isEmpty() || ringFilled == 0) return ""
        val preRollMs = 3000L
        val windowMs = (endMs - silenceStartMs) + preRollMs
        var count = ((windowMs * ringRate) / 1000L).toInt()
        count = min(count, ringFilled)
        count = min(count, ringRate * 20)          // hard cap ~20s
        if (count <= 0) return ""
        val out = ShortArray(count)
        // ringPos is the next write slot; the most recent sample is at ringPos-1.
        // Copy the last `count` samples in chronological order.
        var idx = (ringPos - count + ring.size) % ring.size
        for (i in 0 until count) {
            out[i] = ring[idx]
            idx = (idx + 1) % ring.size
        }
        return writeWav(out, ringRate, "pause_${System.currentTimeMillis()}.wav")
    }

    /** Shared 16-bit mono WAV writer. Returns the absolute path or "". */
    private fun writeWav(samples: ShortArray, rate: Int, name: String): String {
        if (samples.isEmpty()) return ""
        val dir = clipsDir ?: return ""
        return try {
            val file = File(dir, name)
            val dataBytes = samples.size * 2
            val fos = FileOutputStream(file)
            val header = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
            header.put("RIFF".toByteArray())
            header.putInt(36 + dataBytes)
            header.put("WAVE".toByteArray())
            header.put("fmt ".toByteArray())
            header.putInt(16)                 // subchunk1 size
            header.putShort(1)                // PCM
            header.putShort(1)                // mono
            header.putInt(rate)
            header.putInt(rate * 2)           // byte rate (rate * channels * bytesPerSample)
            header.putShort(2)                // block align
            header.putShort(16)               // bits per sample
            header.put("data".toByteArray())
            header.putInt(dataBytes)
            fos.write(header.array())
            val body = ByteBuffer.allocate(dataBytes).order(ByteOrder.LITTLE_ENDIAN)
            for (s in samples) body.putShort(s)
            fos.write(body.array())
            fos.flush(); fos.close()
            file.absolutePath
        } catch (e: Exception) {
            ""
        }
    }
}
