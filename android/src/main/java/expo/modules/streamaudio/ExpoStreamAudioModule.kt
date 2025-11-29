package expo.modules.streamaudio

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import androidx.core.content.ContextCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

import java.io.File
import java.io.RandomAccessFile
import java.util.UUID

private const val DEFAULT_BUFFER_CHUNK_SECONDS = 300
private const val DEFAULT_MAX_BUFFERED_MINUTES = 60

data class BufferedSegmentInfo(
  val id: String,
  val uri: String,
  val sampleRate: Int,
  val startTimestamp: Long,
  val durationMs: Long,
  val sizeBytes: Long,
) {
  fun toMap(): Map<String, Any> = mapOf(
    "id" to id,
    "uri" to uri,
    "sampleRate" to sampleRate,
    "startTimestamp" to startTimestamp,
    "durationMs" to durationMs,
    "sizeBytes" to sizeBytes,
  )
}

private class BufferedSegmentWriter(
  directory: File,
  val sampleRate: Int,
  val startTimestamp: Long,
) {
  val id: String = UUID.randomUUID().toString()
  val file: File = File(directory, "segment_${startTimestamp}_$id.wav")

  private val raf: RandomAccessFile = RandomAccessFile(file, "rw")
  var bytesWritten: Long = 0
    private set

  init {
    if (!directory.exists()) {
      directory.mkdirs()
    }
    raf.write(buildWavHeader(0, sampleRate))
  }

  fun append(bytes: ByteArray, length: Int) {
    raf.seek(raf.length())
    raf.write(bytes, 0, length)
    bytesWritten += length.toLong()
  }

  fun finalizeSegment(): BufferedSegmentInfo? {
    if (bytesWritten <= 0) {
      raf.close()
      file.delete()
      return null
    }

    val dataSize = bytesWritten.toInt()
    raf.seek(0)
    raf.write(buildWavHeader(dataSize, sampleRate))
    raf.close()

    val bytesPerSecond = sampleRate * 2.0 // mono, 16‑bit
    val durationMs = ((bytesWritten / bytesPerSecond) * 1000.0).toLong()

    return BufferedSegmentInfo(
      id = id,
      uri = file.toURI().toString(),
      sampleRate = sampleRate,
      startTimestamp = startTimestamp,
      durationMs = durationMs,
      sizeBytes = bytesWritten,
    )
  }

  fun discard() {
    try {
      raf.close()
    } catch (_: Throwable) {
      // ignore
    }
    file.delete()
  }

  private fun buildWavHeader(dataSize: Int, sampleRate: Int): ByteArray {
    val totalDataLen = 36 + dataSize
    val byteRate = sampleRate * 2 // mono, 16‑bit
    val header = ByteArray(44)

    // RIFF chunk descriptor
    header[0] = 'R'.code.toByte()
    header[1] = 'I'.code.toByte()
    header[2] = 'F'.code.toByte()
    header[3] = 'F'.code.toByte()
    writeIntLE(totalDataLen, header, 4)

    // WAVE
    header[8] = 'W'.code.toByte()
    header[9] = 'A'.code.toByte()
    header[10] = 'V'.code.toByte()
    header[11] = 'E'.code.toByte()

    // fmt subchunk
    header[12] = 'f'.code.toByte()
    header[13] = 'm'.code.toByte()
    header[14] = 't'.code.toByte()
    header[15] = ' '.code.toByte()
    writeIntLE(16, header, 16) // Subchunk1Size
    writeShortLE(1, header, 20) // PCM
    writeShortLE(1, header, 22) // mono
    writeIntLE(sampleRate, header, 24)
    writeIntLE(byteRate, header, 28)
    writeShortLE(2, header, 32) // blockAlign
    writeShortLE(16, header, 34) // bitsPerSample

    // data subchunk
    header[36] = 'd'.code.toByte()
    header[37] = 'a'.code.toByte()
    header[38] = 't'.code.toByte()
    header[39] = 'a'.code.toByte()
    writeIntLE(dataSize, header, 40)

    return header
  }

  private fun writeIntLE(value: Int, buffer: ByteArray, offset: Int) {
    buffer[offset] = (value and 0xFF).toByte()
    buffer[offset + 1] = (value shr 8 and 0xFF).toByte()
    buffer[offset + 2] = (value shr 16 and 0xFF).toByte()
    buffer[offset + 3] = (value shr 24 and 0xFF).toByte()
  }

  private fun writeShortLE(value: Int, buffer: ByteArray, offset: Int) {
    buffer[offset] = (value and 0xFF).toByte()
    buffer[offset + 1] = (value shr 8 and 0xFF).toByte()
  }
}

class ExpoStreamAudioModule : Module() {
  private var audioRecord: AudioRecord? = null
  private var isRecording: Boolean = false
  private var sampleRate: Int = 16000
  private var frameDurationMs: Int = 20
  @Volatile private var shouldRecord: Boolean = false
  private var recordingThread: Thread? = null

  // Buffering configuration and state
  private var bufferingEnabled: Boolean = false
  private var bufferChunkSeconds: Int = DEFAULT_BUFFER_CHUNK_SECONDS
  private var maxBufferedMinutes: Int = DEFAULT_MAX_BUFFERED_MINUTES
  private var currentSegmentWriter: BufferedSegmentWriter? = null
  private val bufferedSegments = mutableListOf<BufferedSegmentInfo>()
  private val bufferLock = Any()

  override fun definition() = ModuleDefinition {
    Name("ExpoStreamAudio")

    Events("onFrame", "onError")

    AsyncFunction("requestPermission") {
      val context = appContext.reactContext ?: return@AsyncFunction "undetermined"
      val status = ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO)
      when (status) {
        PackageManager.PERMISSION_GRANTED -> "granted"
        PackageManager.PERMISSION_DENIED -> "denied"
        else -> "undetermined"
      }
    }

    AsyncFunction("start") { options: Map<String, Any?> ->
      if (isRecording) {
        return@AsyncFunction
      }

      val context = appContext.reactContext
      if (context == null) {
        sendError("React context is null.")
        return@AsyncFunction
      }

      val permissionStatus = ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO)
      if (permissionStatus != PackageManager.PERMISSION_GRANTED) {
        sendError("Microphone permission not granted.")
        return@AsyncFunction
      }

      val requestedSampleRate = (options["sampleRate"] as? Number)?.toInt()
      frameDurationMs = (options["frameDurationMs"] as? Number)?.toInt() ?: 20
      val enableBackground = (options["enableBackground"] as? Boolean) == true

      bufferingEnabled = (options["enableBuffering"] as? Boolean) == true
      bufferChunkSeconds = (options["bufferChunkSeconds"] as? Number)?.toInt()
        ?.takeIf { it > 0 } ?: DEFAULT_BUFFER_CHUNK_SECONDS
      maxBufferedMinutes = (options["maxBufferedMinutes"] as? Number)?.toInt()
        ?.takeIf { it > 0 } ?: DEFAULT_MAX_BUFFERED_MINUTES

      sampleRate = chooseSampleRate(requestedSampleRate)
      val minBufferSize = AudioRecord.getMinBufferSize(
        sampleRate,
        AudioFormat.CHANNEL_IN_MONO,
        AudioFormat.ENCODING_PCM_16BIT
      )

      if (minBufferSize <= 0) {
        sendError("Failed to determine buffer size for sample rate $sampleRate.")
        return@AsyncFunction
      }

      val bytesPerFrame = 2 // PCM 16‑bit mono
      val frameSizeBytes = (sampleRate * frameDurationMs / 1000) * bytesPerFrame
      val bufferSize = maxOf(minBufferSize, frameSizeBytes)

      // Prefer VOICE_RECOGNITION for speech use-cases; fall back to MIC if needed.
      val candidateSources = listOf(
        MediaRecorder.AudioSource.VOICE_RECOGNITION,
        MediaRecorder.AudioSource.VOICE_COMMUNICATION,
        MediaRecorder.AudioSource.MIC,
      )

      var createdRecord: AudioRecord? = null
      for (source in candidateSources) {
        try {
          val record = AudioRecord(
            source,
            sampleRate,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
            bufferSize,
          )
          if (record.state == AudioRecord.STATE_INITIALIZED) {
            createdRecord = record
            break
          } else {
            record.release()
          }
        } catch (_: Throwable) {
          // Try next source
        }
      }

      audioRecord = createdRecord

      if (audioRecord?.state != AudioRecord.STATE_INITIALIZED) {
        sendError("AudioRecord failed to initialize.")
        audioRecord?.release()
        audioRecord = null
        return@AsyncFunction
      }

      if (enableBackground) {
        startForegroundService(context)
      }

      shouldRecord = true
      isRecording = true
      audioRecord?.startRecording()

      recordingThread = Thread {
        val buffer = ByteArray(frameSizeBytes)
        while (shouldRecord) {
          val read = audioRecord?.read(buffer, 0, buffer.size) ?: break
          when {
            read > 0 -> {
              val frame = buffer.copyOf(read)
              emitFrame(frame, sampleRate)
            }
            read == 0 -> {
              sendError("AudioRecord read returned 0 bytes")
            }
            else -> {
              sendError("AudioRecord read error code: $read")
              break
            }
          }
        }
      }.apply { start() }
    }

    AsyncFunction("stop") {
      stopRecordingInternal()
    }

    AsyncFunction("getStatus") {
      if (isRecording) "recording" else "idle"
    }

    AsyncFunction("setBufferingEnabled") { enabled: Boolean ->
      synchronized(bufferLock) {
        bufferingEnabled = enabled
        if (!enabled) {
          finalizeCurrentSegmentIfNeeded()
        }
      }
    }

    AsyncFunction("getBufferedSegments") {
      synchronized(bufferLock) {
        bufferedSegments.map { it.toMap() }
      }
    }

    AsyncFunction("clearBufferedSegments") {
      synchronized(bufferLock) {
        currentSegmentWriter?.discard()
        currentSegmentWriter = null
        bufferedSegments.forEach { info ->
          try {
            val file = File(Uri.parse(info.uri).path ?: return@forEach)
            if (file.exists()) {
              file.delete()
            }
          } catch (_: Throwable) {
            // ignore
          }
        }
        bufferedSegments.clear()
      }
    }
  }

  private fun chooseSampleRate(requested: Int?): Int {
    val candidates = mutableListOf<Int>()
    if (requested != null) {
      candidates.add(requested)
    }
    candidates.addAll(listOf(16000, 44100, 48000))

    for (rate in candidates.distinct()) {
      val result = AudioRecord.getMinBufferSize(
        rate,
        AudioFormat.CHANNEL_IN_MONO,
        AudioFormat.ENCODING_PCM_16BIT
      )
      if (result > 0) {
        return rate
      }
    }

    return 16000
  }

  private fun emitFrame(frame: ByteArray, sampleRate: Int) {
    val base64 = android.util.Base64.encodeToString(frame, android.util.Base64.NO_WRAP)
    val level = calculateRms(frame)
    val timestamp = System.currentTimeMillis()
    val event = mapOf(
      "pcmBase64" to base64,
      "sampleRate" to sampleRate,
      "timestamp" to timestamp,
      "level" to level
    )
    sendEvent("onFrame", event)

    if (bufferingEnabled) {
      appendToBuffer(frame, sampleRate, timestamp)
    }
  }

  private fun stopRecordingInternal() {
    if (!isRecording) return
    shouldRecord = false
    try {
      audioRecord?.stop()
    } catch (e: Throwable) {
      sendError("Failed to stop AudioRecord: ${e.message ?: "unknown error"}")
    }
    audioRecord?.release()
    audioRecord = null
    isRecording = false

    synchronized(bufferLock) {
      finalizeCurrentSegmentIfNeeded()
    }

    // Best-effort stop of foreground service (if started)
    val context = appContext.reactContext
    if (context != null) {
      val intent = Intent(context, StreamAudioService::class.java)
      context.stopService(intent)
    }
  }

  private fun sendError(message: String) {
    sendEvent("onError", mapOf("message" to message))
  }

  private fun calculateRms(bytes: ByteArray): Double {
    if (bytes.size < 2) return 0.0
    var sum = 0.0
    var count = 0
    var i = 0
    while (i + 1 < bytes.size) {
      val sample: Short = (((bytes[i + 1].toInt() shl 8) or (bytes[i].toInt() and 0xFF))).toShort()
      val normalized = sample.toDouble() / Short.MAX_VALUE.toDouble()
      sum += normalized * normalized
      count++
      i += 2
    }
    if (count == 0) return 0.0
    val mean = sum / count.toDouble()
    return kotlin.math.sqrt(mean)
  }

  private fun startForegroundService(context: android.content.Context) {
    try {
      val intent = Intent(context, StreamAudioService::class.java)
      androidx.core.content.ContextCompat.startForegroundService(context, intent)
    } catch (e: Throwable) {
      sendError("Failed to start foreground service: ${e.message ?: "unknown error"}")
    }
  }

  // Buffering helpers

  private fun getBufferDirectory(): File {
    val context = appContext.reactContext
    val baseDir = context?.cacheDir ?: File("/data/local/tmp")
    return File(baseDir, "expo_stream_audio")
  }

  private fun appendToBuffer(frame: ByteArray, sampleRate: Int, timestamp: Long) {
    synchronized(bufferLock) {
      if (!bufferingEnabled) return
      if (currentSegmentWriter == null) {
        currentSegmentWriter = BufferedSegmentWriter(
          directory = getBufferDirectory(),
          sampleRate = sampleRate,
          startTimestamp = timestamp,
        )
      }

      val writer = currentSegmentWriter ?: return
      writer.append(frame, frame.size)

      val bytesPerSecond = sampleRate * 2.0
      val durationSeconds = (writer.bytesWritten / bytesPerSecond)
      if (durationSeconds >= bufferChunkSeconds.toDouble()) {
        finalizeCurrentSegmentIfNeeded()
      }
    }
  }

  private fun finalizeCurrentSegmentIfNeeded() {
    val writer = currentSegmentWriter ?: return
    val info = writer.finalizeSegment()
    currentSegmentWriter = null
    if (info != null) {
      bufferedSegments.add(info)
      enforceMaxBufferedMinutes()
    }
  }

  private fun enforceMaxBufferedMinutes() {
    val maxMs = maxBufferedMinutes * 60_000L
    var totalMs = bufferedSegments.fold(0L) { acc, item -> acc + item.durationMs }
    while (totalMs > maxMs && bufferedSegments.isNotEmpty()) {
      val oldest = bufferedSegments.removeAt(0)
      try {
        val file = File(Uri.parse(oldest.uri).path ?: return)
        if (file.exists()) {
          file.delete()
        }
      } catch (_: Throwable) {
        // ignore
      }
      totalMs = bufferedSegments.fold(0L) { acc, item -> acc + item.durationMs }
    }
  }
}
