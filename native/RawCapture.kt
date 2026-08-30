package com.nocturne.app

import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Debug tap that records a whole night to disk so it can be replayed through the detector.
 *
 * Two files are written side by side:
 *  - `night.wav`   the DECIMATED analysis stream (what the classifier actually consumes).
 *                  Recording the full 44.1 kHz feed would cost ~2.5 GB a night for audio
 *                  the detector never looks at; the decimated stream is ~500 MB.
 *  - `night.chunks` a 12-byte header (magic, version, the sensitivity gate in force) then one
 *                  12-byte record per read: decimated sample count, milliseconds since
 *                  session start, and the RMS the service measured over the FULL-rate read.
 *
 * The sidecar is what makes a replay faithful rather than approximate. Amplitude drives the
 * quiet floor and every episode boundary, and it cannot be recovered from decimated audio —
 * block-mean decimation is a low-pass, so re-measuring it would read the room floor low and
 * open episodes the phone never opened. Recording the timings too means a replay reproduces
 * the real, jittery read schedule instead of an idealised one.
 */
class RawCapture(private val sessionStartMs: Long, private val sensitivity: Double) {

    companion object {
        const val AUDIO_NAME = "night.wav"
        const val SIDECAR_NAME = "night.chunks"
        const val SIDECAR_RECORD_BYTES = 12
        const val SIDECAR_MAGIC = 0x4E43544E   // "NCTN"
        const val SIDECAR_VERSION = 1
        private const val HEADER_BYTES = 44
        private const val BITS_PER_SAMPLE = 16
        private const val CHANNELS = 1
        private const val BYTES_PER_SAMPLE = 2
        // Storage guard: the 12h session cap already bounds this to ~760 MB, so hitting the
        // limit means something is wrong. Recording stops and both files stay valid.
        private const val MAX_AUDIO_BYTES = 1_000_000_000L
    }

    /**
     * Continue an existing recording instead of starting a new one. Set before [open] when
     * the service is restarting mid-session: truncating here would throw away the hours
     * already captured, which is exactly the failure this recording exists to avoid.
     */
    var resume = false

    private var audio: RandomAccessFile? = null
    private var sidecar: RandomAccessFile? = null
    private var dataBytes = 0L
    private var stopped = false

    val bytesWritten get() = dataBytes

    fun open(dir: File, rate: Int): Boolean = try {
        val audioFile = File(dir, AUDIO_NAME)
        val sidecarFile = File(dir, SIDECAR_NAME)
        val continuing = resume && audioFile.length() > HEADER_BYTES && sidecarFile.length() > 0
        if (!continuing) {
            audioFile.delete()
            sidecarFile.delete()
        }
        val out = RandomAccessFile(audioFile, "rw")
        val meta = RandomAccessFile(sidecarFile, "rw")
        if (continuing) {
            dataBytes = audioFile.length() - HEADER_BYTES
            out.seek(audioFile.length())
            meta.seek(sidecarFile.length())
        } else {
            out.write(header(rate))
            // header, so a recording carries the gate it was captured with rather than
            // relying on whatever the replaying machine happens to default to
            val head = ByteBuffer.allocate(SIDECAR_RECORD_BYTES).order(ByteOrder.LITTLE_ENDIAN)
            head.putInt(SIDECAR_MAGIC)
            head.putInt(SIDECAR_VERSION)
            head.putFloat(sensitivity.toFloat())
            meta.write(head.array())
            dataBytes = 0L
        }
        audio = out
        sidecar = meta
        stopped = false
        true
    } catch (e: Exception) {
        audio = null
        sidecar = null
        false
    }

    /** Decimate this read into the recording and note what the service measured for it. */
    fun append(chunk: EpisodeSegmenter.Chunk) {
        val out = audio ?: return
        if (stopped) return
        if (dataBytes >= MAX_AUDIO_BYTES) { stopped = true; return }
        val factor = AcousticFeatures.DECIM_FACTOR
        val count = chunk.length / factor
        if (count <= 0) return
        val body = ByteBuffer.allocate(count * BYTES_PER_SAMPLE).order(ByteOrder.LITTLE_ENDIAN)
        var i = 0
        while (i + factor <= chunk.length) {
            var sum = 0
            for (k in 0 until factor) sum += chunk.samples[i + k]
            body.putShort((sum / factor).toShort())
            i += factor
        }
        try {
            out.write(body.array())
            dataBytes += body.capacity()
            writeSidecar(count, chunk)
        } catch (e: Exception) {
            stopped = true
        }
    }

    /** Patch the WAV sizes now that the length is known, and release both files. */
    fun close() {
        val out = audio
        if (out != null) {
            try {
                out.seek(4)
                out.write(intLe((HEADER_BYTES - 8) + dataBytes))
                out.seek(40)
                out.write(intLe(dataBytes))
            } catch (e: Exception) {
                // a truncated recording is still worth keeping; the reader uses the file size
            }
            try { out.close() } catch (e: Exception) {}
        }
        try { sidecar?.close() } catch (e: Exception) {}
        audio = null
        sidecar = null
    }

    private fun writeSidecar(count: Int, chunk: EpisodeSegmenter.Chunk) {
        val meta = sidecar ?: return
        val record = ByteBuffer.allocate(SIDECAR_RECORD_BYTES).order(ByteOrder.LITTLE_ENDIAN)
        record.putInt(count)
        record.putInt((chunk.atMs - sessionStartMs).toInt())
        record.putFloat(chunk.amp.toFloat())
        meta.write(record.array())
    }

    private fun header(rate: Int): ByteArray {
        val byteRate = rate * CHANNELS * BYTES_PER_SAMPLE
        val h = ByteBuffer.allocate(HEADER_BYTES).order(ByteOrder.LITTLE_ENDIAN)
        h.put("RIFF".toByteArray())
        h.putInt(0)                       // patched on close
        h.put("WAVE".toByteArray())
        h.put("fmt ".toByteArray())
        h.putInt(16)                      // subchunk1 size
        h.putShort(1)                     // PCM
        h.putShort(CHANNELS.toShort())
        h.putInt(rate)
        h.putInt(byteRate)
        h.putShort((CHANNELS * BYTES_PER_SAMPLE).toShort())
        h.putShort(BITS_PER_SAMPLE.toShort())
        h.put("data".toByteArray())
        h.putInt(0)                       // patched on close
        return h.array()
    }

    private fun intLe(value: Long): ByteArray =
        ByteBuffer.allocate(4).order(ByteOrder.LITTLE_ENDIAN).putInt(value.toInt()).array()
}
