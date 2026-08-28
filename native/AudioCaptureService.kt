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
import android.os.VibrationEffect
import android.os.Vibrator
import androidx.core.app.NotificationCompat
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
        @Volatile var running = false
        @Volatile var sensitivityRatio = 1.4   // auto wake-gate; updated live from the plugin
    }

    private var thread: Thread? = null
    @Volatile private var stopRequested = false

    // detection state
    private var baseline = 0.012
    private var startMs = 0L
    private var calibrating = true
    private var calibStart = 0L
    private val calibSamples = ArrayList<Double>()

    // Rolling quiet-floor estimate (replaces the one-sided EMA): the baseline is a low
    // percentile of recent amplitudes, clamped. It adapts both up and down, so a bad 4s
    // calibration can't pin the level scale, and it settles within ~the window length
    // instead of creeping there over a minute. floorMin is deliberately low so low-gain
    // capture paths (UNPROCESSED with no AGC) aren't clamped above their real floor.
    private val floorWin = ArrayDeque<Double>()
    private val floorWinMax = 300   // ~30s at ~10 reads/s
    private val floorLoPct = 0.15   // 15th percentile ≈ the quiet floor
    private val floorMin = 0.001
    private val floorMax = 0.05
    // open continuous-snore episode being merged
    private var epActive = false
    private var epStartMs = 0L
    private var epLastActiveMs = 0L
    private var epPeak = 0
    // silence-based pause tracking (apnea = true silence after a snore episode)
    private var silentSinceMs = 0L
    private var lastEpLoudMs = 0L
    private var lastEpDurSec = 0.0
    private val minEpisodePeak = 20   // must at some point reach ~2x the room floor to be a snore

    // acoustic classification (snore / movement / other) of each episode
    private val epClf = AcousticFeatures.EpisodeClassifier()
    private val frameBuf = ArrayList<Double>(AcousticFeatures.FRAME_FFT * 3)
    private val analysisFrame = DoubleArray(AcousticFeatures.FRAME_FFT)
    private val frameFeat = AcousticFeatures.FrameFeatures()
    private var decimRate = 44100 / AcousticFeatures.DECIM_FACTOR
    private var movementCount = 0
    private var otherCount = 0
    private var lastSampleMs = 0L
    private var snoreCount = 0
    private var pauseCount = 0

    private val calibrationMs = 4000L
    // Quiet allowed inside one continuous episode. This must stay well BELOW the
    // inter-breath pause (typically 1.5-3.5 s) or consecutive snores merge into a single
    // episode, which then has nothing to pair with in the rhythm gate below and can never
    // be confirmed. It only needs to bridge dips *within* one snore (< 0.3 s).
    private val snoreMergeGapMs = 700L
    private val maxEpisodeMs = 120_000L   // continuous sound beyond this is cut and classified
    private val minEpisodeDurSec = 0.35   // shorter than this is a breath blip, not a snore
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
            File(dir, "session.json").writeText(
                "{\"active\":$active,\"startMs\":$startMs,\"sensitivity\":$sensitivityRatio}")
        } catch (_: Exception) {}
    }

    // audio clip capture for the current episode (real snore audio for playback)
    private var epClip: ArrayList<Short>? = null
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
        sensitivityRatio = intent?.getDoubleExtra(EXTRA_SENSITIVITY, 1.4) ?: 1.4
        // parse smart-alarm config
        alarmEnabled = intent?.getBooleanExtra(EXTRA_ALARM_ENABLED, false) ?: false
        if (alarmEnabled) {
            val hhmm = intent?.getStringExtra(EXTRA_ALARM_TIME) ?: "07:00"
            val windowMin = intent?.getIntExtra(EXTRA_ALARM_WINDOW, 30) ?: 30
            computeAlarmWindow(hhmm, windowMin)
            alarmFired = false
        }
        startForegroundWithNotification()
        if (!running) {
            running = true
            stopRequested = false
            thread = Thread { captureLoop() }.also { it.start() }
        }
        return START_STICKY
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

        val recorder = try {
            (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N)
                named(MediaRecorder.AudioSource.UNPROCESSED, "UNPROCESSED") else null)
                ?: named(MediaRecorder.AudioSource.VOICE_RECOGNITION, "VOICE_RECOGNITION")
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
        startMs = System.currentTimeMillis()
        calibStart = startMs
        calibrating = true
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
        // begin a fresh persisted session for overnight re-attach
        sessionDir = File(filesDir, "nocturne_session").apply { mkdirs() }
        sessionLog = File(sessionDir, "events.jsonl").apply { runCatching { if (exists()) delete() } }
        writeSessionMeta(true)

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
            val amp = rms(buffer, read)
            trackSilentStream(amp)
            val now = System.currentTimeMillis()

            // morning safety net: a recording left running for 12h+ auto-stops so it
            // doesn't run all day and drain the battery if the user forgets to tap stop.
            // (The state event is emitted AFTER the post-loop flush, so the final
            // episode/pause events reach the UI before it tears down its listeners.)
            if (now - startMs > maxSessionMs) break
            if (calibrating) {
                calibSamples.add(amp)
                val leftSec = max(0L, calibrationMs - (now - calibStart)) / 1000.0
                NocturnePlugin.emitCalibrating(amp, leftSec)
                if (now - calibStart >= calibrationMs) {
                    val sorted = calibSamples.sorted()
                    val med = if (sorted.isEmpty()) 0.012 else sorted[sorted.size / 2]
                    baseline = max(floorMin, med)
                    // seed the rolling floor with the calibration samples so it starts
                    // from measured room tone and adapts from there.
                    floorWin.clear(); floorWin.addAll(calibSamples)
                    while (floorWin.size > floorWinMax) floorWin.removeFirst()
                    calibrating = false
                    NocturnePlugin.emitState("listening", amp, snoreCount, pauseCount, baseline)
                }
                continue
            }

            // adaptive quiet floor: a low percentile of a rolling window, clamped. Tracks
            // the true room floor up or down and can't be pinned by a bad calibration.
            floorWin.addLast(amp)
            while (floorWin.size > floorWinMax) floorWin.removeFirst()
            val fsorted = floorWin.sorted()
            baseline = fsorted[((fsorted.size - 1) * floorLoPct).toInt()].coerceIn(floorMin, floorMax)
            val ratio = amp / max(baseline, 0.0001)
            val level = soundLevel(amp)
            val elapsed = (now - startMs) / 1000.0

            // feed the rolling ring buffer with decimated audio (block-mean by DECIM_FACTOR)
            if (ring.isNotEmpty()) {
                var i = 0
                val f = AcousticFeatures.DECIM_FACTOR
                while (i + f <= read) {
                    var s = 0
                    for (k in 0 until f) s += buffer[i + k]
                    ring[ringPos] = (s / f).toShort()
                    ringPos = (ringPos + 1) % ring.size
                    if (ringFilled < ring.size) ringFilled++
                    i += f
                }
            }

            // downsampled ~1s sample for the timeline
            if (lastSampleMs == 0L || now - lastSampleMs > 1000) {
                lastSampleMs = now
                NocturnePlugin.emitSample(elapsed, amp, level)
                appendSessionEvent("{\"e\":\"sample\",\"t\":${"%.1f".format(Locale.US, elapsed)},\"amp\":${"%.5f".format(Locale.US, amp)},\"lvl\":$level}")
            }

            // smart alarm: within the wake window, fire at a light-sleep moment;
            // at the hard deadline, fire regardless.
            if (alarmEnabled && !alarmFired) {
                recentLevels.addLast(level)
                while (recentLevels.size > 30) recentLevels.removeFirst()  // ~30 reads window
                val past = System.currentTimeMillis()
                if (past >= alarmDeadlineMs) {
                    triggerAlarm()
                } else if (past >= alarmWindowStartMs && isLightSleepNow()) {
                    triggerAlarm()
                }
            }

            val snoreRatio = sensitivityRatio
            if (ratio > snoreRatio) {
                if (!epActive) {
                    epActive = true; epStartMs = now; epLastActiveMs = now; epPeak = level
                    epClip = ArrayList(clipSampleRate * 4)   // start a fresh clip buffer
                    epClf.reset(); frameBuf.clear()          // fresh acoustic analysis
                } else {
                    epLastActiveMs = now
                    if (level > epPeak) epPeak = level
                }
            }
            // while an episode is open, accumulate its audio (capped) + analyse frames
            val clip = epClip
            if (epActive && clip != null && clip.size < clipMaxSamples) {
                val room = clipMaxSamples - clip.size
                val n = min(read, room)
                for (i in 0 until n) clip.add(buffer[i])
            }
            if (epActive) {
                // decimate this chunk and consume full FFT frames for classification
                decimRate = AcousticFeatures.decimateInto(buffer, read, frameBuf, sampleRate)
                while (frameBuf.size >= AcousticFeatures.FRAME_FFT) {
                    for (i in 0 until AcousticFeatures.FRAME_FFT) analysisFrame[i] = frameBuf[i]
                    // drop the consumed frame in one shift (not one element at a time)
                    frameBuf.subList(0, AcousticFeatures.FRAME_FFT).clear()
                    AcousticFeatures.analyzeFrame(analysisFrame, decimRate, frameFeat)
                    epClf.add(frameFeat)
                }
            }
            // finalize an open episode only after continuous quiet beyond the merge gap
            if (epActive && (now - epLastActiveMs) >= snoreMergeGapMs) {
                finalizeEpisode(false)
            }
            // Length guard for a sound that stays continuously loud (a fan or AC turning
            // on). It is classified and emitted rather than discarded — a long sound is
            // still evidence, and silently deleting it was hiding real snoring. The floor
            // needs no rebasing here: it is recomputed from the percentile window every
            // pass, so any sustained rise is already tracked.
            if (epActive && (now - epStartMs) > maxEpisodeMs) {
                finalizeEpisode(true)
            }

            // breathing-pause / apnea flag — near-TOTAL silence (well below breathing
            // sounds), 9-60s long, following a genuine snore episode (>=2s). Measured
            // when sound resumes so the recorded duration is the real gap length.
            // Quiet breathing stays above the silence floor and no longer counts.
            val silent = amp < baseline * 1.2
            if (silent) {
                if (silentSinceMs == 0L) silentSinceMs = now
            } else {
                if (silentSinceMs != 0L) {
                    val gap = (now - silentSinceMs) / 1000.0
                    val sinceEp = if (lastEpLoudMs != 0L) (silentSinceMs - lastEpLoudMs) / 1000.0 else Double.MAX_VALUE
                    if (gap in 9.0..60.0 && lastEpDurSec >= 2.0 && sinceEp in -2.0..20.0) {
                        pauseCount++
                        // save context audio: from ~3s before the silence began, through
                        // the silence, to now (the gasp/resumption). Read from the ring.
                        val path = writePauseClip(silentSinceMs, now)
                        val pt = (silentSinceMs - startMs) / 1000.0
                        NocturnePlugin.emitPause(pt, gap, pauseCount, path)
                        appendSessionEvent("{\"e\":\"pause\",\"t\":${"%.1f".format(Locale.US, pt)},\"dur\":${"%.1f".format(Locale.US, gap)},\"count\":$pauseCount,\"clip\":${jsonStr(path)}}")
                    }
                    silentSinceMs = 0L
                }
            }

            NocturnePlugin.emitLevel(level, ratio > snoreRatio, elapsed, baseline)
        }

        // flush a snore episode still open when recording stops
        if (epActive) {
            finalizeEpisode(false)
        }
        // flush a pause still open at stop (silence continued to the end)
        if (silentSinceMs != 0L) {
            val nowStop = System.currentTimeMillis()
            val gap = (nowStop - silentSinceMs) / 1000.0
            val sinceEp = if (lastEpLoudMs != 0L) (silentSinceMs - lastEpLoudMs) / 1000.0 else Double.MAX_VALUE
            if (gap in 9.0..60.0 && lastEpDurSec >= 2.0 && sinceEp in -2.0..20.0) {
                pauseCount++
                val path = writePauseClip(silentSinceMs, nowStop)
                val pt = (silentSinceMs - startMs) / 1000.0
                NocturnePlugin.emitPause(pt, gap, pauseCount, path)
                appendSessionEvent("{\"e\":\"pause\",\"t\":${"%.1f".format(Locale.US, pt)},\"dur\":${"%.1f".format(Locale.US, gap)},\"count\":$pauseCount,\"clip\":${jsonStr(path)}}")
            }
            silentSinceMs = 0L
        }

        try { recorder.stop() } catch (_: Exception) {}
        recorder.release()

        // if we exited the loop on our own (12h cap) rather than a user stop, mark the
        // session ended and shut down — emitted AFTER the flush so no events are lost.
        if (!stopRequested) {
            writeSessionMeta(false)
            running = false
            NocturnePlugin.emitState("auto-stopped", 0.0, snoreCount, pauseCount, baseline)
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
    /** Build the diagnostic record for the episode being finalized. */
    private fun episodeRecord(durSec: Double): EpisodeLog.EpisodeRecord {
        val record = EpisodeLog.EpisodeRecord()
        record.onset = (epStartMs - startMs) / 1000.0
        record.durSec = durSec
        record.peak = epPeak
        record.baseline = baseline
        record.frames = epClf.frameCount
        return record
    }

    /**
     * Close the open episode: classify it, route it, and always log why it was or wasn't
     * accepted. `forced` marks an episode cut short by the max-length guard rather than by
     * a genuine drop to quiet.
     */
    private fun finalizeEpisode(forced: Boolean) {
        val durSec = (epLastActiveMs - epStartMs) / 1000.0
        val record = episodeRecord(durSec)
        var features: AcousticFeatures.EpisodeClassifier.Snapshot? = null

        if (durSec <= minEpisodeDurSec) {
            record.reject = EpisodeLog.REASON_SHORT
        } else if (epPeak < minEpisodePeak) {
            record.reject = EpisodeLog.REASON_QUIET
        } else {
            // classify using the (possibly calibrated) per-user F0 band
            val kind = if (epClf.frameCount > 0) epClf.classify(userF0Lo, userF0Hi) else "other"
            features = if (epClf.frameCount > 0) epClf.snapshot else null
            record.kind = kind
            val onset = record.onset
            if (kind == "snore") {
                // snore-LIKE: hold as pending, confirm by rhythm against the last snore/pending
                handleSnoreCandidate(onset, durSec, epPeak, writeClip(epClip, 0), epClf.dominantF0)
            } else {
                record.reject = EpisodeLog.REASON_NOT_SNORE + kind
                if (kind == "movement") movementCount++ else otherCount++
                NocturnePlugin.emitSound(onset, durSec, epPeak, kind,
                    if (kind == "movement") movementCount else otherCount)
                appendSessionEvent("{\"e\":\"sound\",\"t\":${"%.1f".format(Locale.US, onset)},\"dur\":${"%.2f".format(Locale.US, durSec)},\"lvl\":$epPeak,\"kind\":\"$kind\"}")
            }
        }
        if (forced) record.reject = EpisodeLog.REASON_MAX_EPISODE
        appendSessionEvent(EpisodeLog.episode(record, features))

        epActive = false; epClip = null
        epClf.reset(); frameBuf.clear()
    }

    // ---- rhythm confirmation + F0 calibration state ----
    private var pendingOnset = -1.0
    private var pendingDur = 0.0
    private var pendingPeak = 0
    private var pendingClip = ""
    private var pendingF0 = 0.0
    private var lastConfirmedOnset = -100.0
    private val f0Samples = ArrayList<Double>()
    private var userF0Lo = 60.0    // calibrated per user; starts at the general snore band
    private var userF0Hi = 320.0
    // Onset-to-onset gap between consecutive snores in a train. The upper bound sets the
    // slowest breathing rate that can be confirmed: 8.0 s covers down to 7.5 breaths/min,
    // and with the 0.7 s merge gap the lower bound reaches 40 breaths/min — the whole
    // physiological range. (At the previous 4 s merge gap the achievable range collapsed
    // to 8.6-13.8 breaths/min, below normal adult sleeping rates, so almost nothing
    // could ever be confirmed.)
    private val snoreTrainMin = 1.5   // s — min gap between snores in a train
    private val snoreTrainMax = 8.0   // s — max gap

    /** Record which branch the rhythm gate took, so a night of misses is diagnosable. */
    private fun logRhythm(onset: Double, outcome: String) {
        val gaps = EpisodeLog.RhythmGaps(
            onset - lastConfirmedOnset,
            if (pendingOnset >= 0) onset - pendingOnset else -1.0
        )
        appendSessionEvent(EpisodeLog.rhythm(onset, gaps, outcome))
    }

    private fun handleSnoreCandidate(onset: Double, dur: Double, peak: Int, clip: String, f0: Double) {
        // does this candidate form a train with the last confirmed snore?
        val gapFromConfirmed = onset - lastConfirmedOnset
        if (gapFromConfirmed in snoreTrainMin..snoreTrainMax) {
            logRhythm(onset, "confirmed-by-train")
            emitConfirmedSnore(onset, dur, peak, clip, f0)
            return
        }
        // otherwise, try to pair with a held pending candidate
        if (pendingOnset >= 0) {
            val gap = onset - pendingOnset
            if (gap in snoreTrainMin..snoreTrainMax) {
                // a train of two — confirm the pending one, then this one
                logRhythm(onset, "confirmed-pair")
                emitConfirmedSnore(pendingOnset, pendingDur, pendingPeak, pendingClip, pendingF0)
                emitConfirmedSnore(onset, dur, peak, clip, f0)
                clearPending()
                return
            } else {
                // the old pending was isolated → it was noise, not a snore. Drop it.
                logRhythm(onset, "pending-dropped")
                clearPending()
            }
        } else {
            logRhythm(onset, "held-pending")
        }
        // hold this one as the new pending candidate
        pendingOnset = onset; pendingDur = dur; pendingPeak = peak; pendingClip = clip; pendingF0 = f0
    }

    private fun emitConfirmedSnore(onset: Double, dur: Double, peak: Int, clip: String, f0: Double) {
        snoreCount++
        NocturnePlugin.emitSnore(onset, dur, peak, snoreCount, clip)
        appendSessionEvent("{\"e\":\"snore\",\"t\":${"%.1f".format(Locale.US, onset)},\"dur\":${"%.2f".format(Locale.US, dur)},\"lvl\":$peak,\"count\":$snoreCount,\"clip\":${jsonStr(clip)}}")
        lastConfirmedOnset = onset
        lastEpLoudMs = startMs + (onset * 1000).toLong() + (dur * 1000).toLong()
        lastEpDurSec = dur
        // accumulate F0 for per-user calibration
        if (f0 in 50.0..400.0) {
            f0Samples.add(f0)
            if (f0Samples.size >= 8) recalibrateF0()
        }
    }

    private fun clearPending() { pendingOnset = -1.0; pendingClip = "" }

    /** Narrow the accepted snore-F0 band to this user's own pitch (median ± spread). */
    private fun recalibrateF0() {
        val sorted = f0Samples.sorted()
        val median = sorted[sorted.size / 2]
        // spread: keep a band around the user's median but never absurdly tight
        userF0Lo = max(50.0, median - 90.0)
        userF0Hi = min(400.0, median + 120.0)
        // cap memory
        if (f0Samples.size > 200) f0Samples.subList(0, f0Samples.size - 200).clear()
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

    private fun rms(buf: ShortArray, len: Int): Double {
        var sum = 0.0
        for (i in 0 until len) {
            val v = buf[i] / 32768.0
            sum += v * v
        }
        return sqrt(sum / len)
    }

    private fun soundLevel(amp: Double): Int {
        val b = if (baseline > 0) baseline else 0.01
        val ratio = max(1.0, amp / b)
        val lvl = log2(ratio) / log2(14.0) * 100.0
        return max(0.0, min(100.0, lvl)).toInt()
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
    private fun writeClip(samples: ArrayList<Short>?, index: Int): String {
        if (samples == null || samples.isEmpty()) return ""
        val arr = ShortArray(samples.size)
        for (i in samples.indices) arr[i] = samples[i]
        return writeWav(arr, clipSampleRate, "snore_${System.currentTimeMillis()}_$index.wav")
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
