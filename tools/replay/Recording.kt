package com.nocturne.replay

import com.nocturne.app.RawCapture
import java.io.BufferedInputStream
import java.io.DataInputStream
import java.io.File
import java.io.FileInputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Streams a recorded night back off disk: the decimated audio and, read for read, the
 * amplitude and timing the phone measured. Both are needed — see [RawCapture] for why the
 * amplitude cannot be recovered from the audio alone.
 */
class Recording {

    companion object {
        private const val WAV_HEADER_BYTES = 44
        private const val RATE_OFFSET = 24
        private const val BYTES_PER_SAMPLE = 2
    }

    /** One recorded read, refilled in place so a long night does not churn the heap. */
    class Read {
        var samples: ShortArray = ShortArray(0)
        var count = 0
        var atMs = 0
        var amp = 0.0
    }

    var sampleRate = 0
        private set
    var sensitivity = 0.0
        private set

    private var audio: DataInputStream? = null
    private var meta: DataInputStream? = null
    private val record = ByteArray(RawCapture.SIDECAR_RECORD_BYTES)
    private var bytes = ByteArray(0)

    /** Returns null on success, or a human-readable reason the recording cannot be read. */
    fun open(audioFile: File): String? {
        val dir = audioFile.parentFile ?: File(".")
        val sidecarFile = File(dir, RawCapture.SIDECAR_NAME)
        if (!sidecarFile.isFile) {
            return "no ${RawCapture.SIDECAR_NAME} beside the audio (expected ${sidecarFile.path})"
        }
        val stream = DataInputStream(BufferedInputStream(FileInputStream(audioFile)))
        val header = ByteArray(WAV_HEADER_BYTES)
        stream.readFully(header)
        if (!tagAt(header, 0, "RIFF") || !tagAt(header, 8, "WAVE")) {
            stream.close()
            return "not a WAV file: ${audioFile.path}"
        }
        sampleRate = ByteBuffer.wrap(header).order(ByteOrder.LITTLE_ENDIAN).getInt(RATE_OFFSET)
        audio = stream

        val metaStream = DataInputStream(BufferedInputStream(FileInputStream(sidecarFile)))
        metaStream.readFully(record)
        val head = ByteBuffer.wrap(record).order(ByteOrder.LITTLE_ENDIAN)
        if (head.int != RawCapture.SIDECAR_MAGIC) {
            close()
            return "not a Nocturne sidecar: ${sidecarFile.path}"
        }
        val version = head.int
        if (version != RawCapture.SIDECAR_VERSION) {
            close()
            return "sidecar version $version, this build reads ${RawCapture.SIDECAR_VERSION}"
        }
        sensitivity = head.float.toDouble()
        meta = metaStream
        return null
    }

    /** Fill `read` with the next recorded chunk; false once the recording runs out. */
    fun next(read: Read): Boolean {
        val metaStream = meta ?: return false
        val audioStream = audio ?: return false
        try {
            metaStream.readFully(record)
        } catch (e: Exception) {
            return false
        }
        val fields = ByteBuffer.wrap(record).order(ByteOrder.LITTLE_ENDIAN)
        val count = fields.int
        read.atMs = fields.int
        read.amp = fields.float.toDouble()
        if (count <= 0) return false
        val needed = count * BYTES_PER_SAMPLE
        if (bytes.size < needed) bytes = ByteArray(needed)
        try {
            audioStream.readFully(bytes, 0, needed)
        } catch (e: Exception) {
            // the audio was truncated (a recording cut short); stop cleanly here
            return false
        }
        if (read.samples.size < count) read.samples = ShortArray(count)
        val body = ByteBuffer.wrap(bytes, 0, needed).order(ByteOrder.LITTLE_ENDIAN)
        for (i in 0 until count) read.samples[i] = body.short
        read.count = count
        return true
    }

    fun close() {
        try { audio?.close() } catch (e: Exception) {}
        try { meta?.close() } catch (e: Exception) {}
        audio = null
        meta = null
    }

    private fun tagAt(buf: ByteArray, at: Int, tag: String): Boolean {
        for (i in tag.indices) if (buf[at + i] != tag[i].code.toByte()) return false
        return true
    }
}
