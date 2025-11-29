import AVFoundation
import ExpoModulesCore

private let DEFAULT_FRAME_DURATION_MS: Double = 20.0
private let DEFAULT_BUFFER_CHUNK_SECONDS: Double = 300.0
private let DEFAULT_MAX_BUFFERED_MINUTES: Double = 60.0

private struct BufferedSegmentInfo {
  let id: String
  let fileURL: URL
  let sampleRate: Double
  let startTimestampMs: Double
  let durationMs: Double
  let sizeBytes: Int64

  func toDictionary() -> [String: Any] {
    return [
      "id": id,
      "uri": fileURL.absoluteString,
      "sampleRate": sampleRate,
      "startTimestamp": startTimestampMs,
      "durationMs": durationMs,
      "sizeBytes": sizeBytes
    ]
  }
}

private final class BufferedSegmentWriter {
  let id: String
  let fileURL: URL
  let sampleRate: Double
  let startTimestampMs: Double

  private let fileHandle: FileHandle
  private(set) var bytesWritten: Int64 = 0

  private var bytesPerSecond: Double {
    return sampleRate * 2.0 // 16‑bit mono
  }

  init?(directory: URL, sampleRate: Double, startTimestampMs: Double) {
    self.id = UUID().uuidString
    self.sampleRate = sampleRate
    self.startTimestampMs = startTimestampMs
    self.fileURL = directory.appendingPathComponent("segment_\(Int(startTimestampMs))_\(id).wav")

    do {
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      FileManager.default.createFile(atPath: fileURL.path, contents: nil)
      self.fileHandle = try FileHandle(forWritingTo: fileURL)
      try writeHeader(dataSize: 0)
    } catch {
      try? FileManager.default.removeItem(at: fileURL)
      return nil
    }
  }

  deinit {
    try? fileHandle.close()
  }

  func append(pcmData: Data) {
    do {
      try fileHandle.seekToEnd()
      try fileHandle.write(contentsOf: pcmData)
      bytesWritten += Int64(pcmData.count)
    } catch {
      // Ignore write errors here; JS will still receive frames via events.
    }
  }

  func finalize() -> BufferedSegmentInfo? {
    if bytesWritten <= 0 {
      try? fileHandle.close()
      try? FileManager.default.removeItem(at: fileURL)
      return nil
    }

    let dataSize = bytesWritten
    let durationSeconds = Double(dataSize) / bytesPerSecond
    let durationMs = durationSeconds * 1000.0

    do {
      try writeHeader(dataSize: UInt32(clamping: Int(dataSize)))
      try fileHandle.close()
    } catch {
      // Best-effort; even if header patch fails, we still report the file.
    }

    return BufferedSegmentInfo(
      id: id,
      fileURL: fileURL,
      sampleRate: sampleRate,
      startTimestampMs: startTimestampMs,
      durationMs: durationMs,
      sizeBytes: dataSize
    )
  }

  func discard() {
    try? fileHandle.close()
    try? FileManager.default.removeItem(at: fileURL)
  }

  private func writeHeader(dataSize: UInt32) throws {
    let byteRate = UInt32(sampleRate * 2.0) // mono, 16‑bit
    let blockAlign: UInt16 = 2
    let bitsPerSample: UInt16 = 16
    let chunkSize = UInt32(36) + dataSize

    var header = Data()
    header.append("RIFF".data(using: .ascii)!)
    header.append(chunkSize.littleEndianData)
    header.append("WAVE".data(using: .ascii)!)
    header.append("fmt ".data(using: .ascii)!)
    header.append(UInt32(16).littleEndianData) // Subchunk1Size
    header.append(UInt16(1).littleEndianData) // PCM
    header.append(UInt16(1).littleEndianData) // mono
    header.append(UInt32(sampleRate).littleEndianData)
    header.append(byteRate.littleEndianData)
    header.append(blockAlign.littleEndianData)
    header.append(bitsPerSample.littleEndianData)
    header.append("data".data(using: .ascii)!)
    header.append(dataSize.littleEndianData)

    try fileHandle.seek(toOffset: 0)
    try fileHandle.write(contentsOf: header)
  }
}

private extension UInt16 {
  var littleEndianData: Data {
    var value = self.littleEndian
    return Data(bytes: &value, count: MemoryLayout<UInt16>.size)
  }
}

private extension UInt32 {
  var littleEndianData: Data {
    var value = self.littleEndian
    return Data(bytes: &value, count: MemoryLayout<UInt32>.size)
  }
}

public class ExpoStreamAudioModule: Module {
  private let audioSession = AVAudioSession.sharedInstance()
  private let audioEngine = AVAudioEngine()
  private var isRecording = false
  private var frameDurationMs: Double = DEFAULT_FRAME_DURATION_MS
  private var enableLevelMeter = false
  private var sampleRate: Double = 0

  // Buffering configuration
  private var bufferingEnabled = false
  private var bufferChunkSeconds: Double = DEFAULT_BUFFER_CHUNK_SECONDS
  private var maxBufferedMinutes: Double = DEFAULT_MAX_BUFFERED_MINUTES

  // Buffering state
  private var bufferDirectory: URL {
    let urls = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)
    return urls[0].appendingPathComponent("expo_stream_audio", isDirectory: true)
  }
  private var currentSegmentWriter: BufferedSegmentWriter?
  private var bufferedSegments: [BufferedSegmentInfo] = []
  private let bufferQueue = DispatchQueue(label: "expo.streamaudio.buffer")

  public func definition() -> ModuleDefinition {
    Name("ExpoStreamAudio")

    Events("onFrame", "onError")

    AsyncFunction("requestPermission") { () -> String in
      switch self.audioSession.recordPermission {
      case .granted:
        return "granted"
      case .denied:
        return "denied"
      case .undetermined:
        return "undetermined"
      @unknown default:
        return "undetermined"
      }
    }

    AsyncFunction("start") { (options: [String: Any]) in
      if self.isRecording {
        return
      }

      // Ensure permission
      let permission = self.audioSession.recordPermission
      if permission == .denied {
        self.sendError("Microphone permission denied.")
        return
      }

      if permission == .undetermined {
        await withCheckedContinuation { continuation in
          self.audioSession.requestRecordPermission { _ in
            continuation.resume()
          }
        }
      }

      self.frameDurationMs = (options["frameDurationMs"] as? Double) ?? DEFAULT_FRAME_DURATION_MS
      self.enableLevelMeter = (options["enableLevelMeter"] as? Bool) ?? false

      self.bufferingEnabled = (options["enableBuffering"] as? Bool) ?? false
      if let chunkSeconds = options["bufferChunkSeconds"] as? Double, chunkSeconds > 0 {
        self.bufferChunkSeconds = chunkSeconds
      } else {
        self.bufferChunkSeconds = DEFAULT_BUFFER_CHUNK_SECONDS
      }
      if let maxMinutes = options["maxBufferedMinutes"] as? Double, maxMinutes > 0 {
        self.maxBufferedMinutes = maxMinutes
      } else {
        self.maxBufferedMinutes = DEFAULT_MAX_BUFFERED_MINUTES
      }

      await self.startRecordingInternal(options: options)
    }

    AsyncFunction("stop") {
      self.stopRecordingInternal()
    }

    AsyncFunction("getStatus") { () -> String in
      return self.isRecording ? "recording" : "idle"
    }

    AsyncFunction("setBufferingEnabled") { (enabled: Bool) in
      self.bufferQueue.sync {
        self.bufferingEnabled = enabled
        if !enabled {
          // Do not create new segments; finalize current if long enough.
          self.finalizeCurrentSegmentIfNeeded()
        }
      }
    }

    AsyncFunction("getBufferedSegments") { () -> [[String: Any]] in
      return self.bufferQueue.sync {
        self.bufferedSegments.map { $0.toDictionary() }
      }
    }

    AsyncFunction("clearBufferedSegments") {
      self.bufferQueue.sync {
        self.currentSegmentWriter?.discard()
        self.currentSegmentWriter = nil
        for segment in self.bufferedSegments {
          try? FileManager.default.removeItem(at: segment.fileURL)
        }
        self.bufferedSegments.removeAll()
      }
    }
  }

  // MARK: - Internal helpers

  private func startRecordingInternal(options: [String: Any]) async {
    do {
      try audioSession.setCategory(.record, mode: .voiceChat, options: [])

      if let requestedSampleRate = options["sampleRate"] as? Double {
        try? audioSession.setPreferredSampleRate(requestedSampleRate)
      }

      try audioSession.setActive(true)
    } catch {
      sendError("Failed to configure audio session: \(error.localizedDescription)")
      return
    }

    let inputNode = audioEngine.inputNode
    let inputFormat = inputNode.inputFormat(forBus: 0)
    sampleRate = inputFormat.sampleRate

    let framesPerBuffer = max(
      256,
      Int(sampleRate * (frameDurationMs / 1000.0))
    )
    let bufferSize = AVAudioFrameCount(framesPerBuffer)

    inputNode.removeTap(onBus: 0)

    inputNode.installTap(onBus: 0, bufferSize: bufferSize, format: inputFormat) { buffer, _ in
      self.handleBuffer(buffer: buffer)
    }

    do {
      try audioEngine.start()
      isRecording = true
    } catch {
      sendError("Failed to start audio engine: \(error.localizedDescription)")
      inputNode.removeTap(onBus: 0)
      isRecording = false
    }
  }

  private func stopRecordingInternal() {
    guard isRecording else { return }
    isRecording = false
    audioEngine.inputNode.removeTap(onBus: 0)
    audioEngine.stop()
    try? audioSession.setActive(false)

    bufferQueue.async {
      self.finalizeCurrentSegmentIfNeeded()
    }
  }

  private func handleBuffer(buffer: AVAudioPCMBuffer) {
    let frameLength = Int(buffer.frameLength)
    let byteCount = frameLength * MemoryLayout<Int16>.size

    let data: Data
    let level: Double?

    if let int16ChannelData = buffer.int16ChannelData {
      data = Data(bytes: int16ChannelData[0], count: byteCount)
      level = enableLevelMeter ? calculateRMS(fromInt16Buffer: int16ChannelData[0], frameLength: frameLength) : nil
    } else if let floatChannelData = buffer.floatChannelData {
      var int16Array = [Int16](repeating: 0, count: frameLength)
      for i in 0..<frameLength {
        let sample = floatChannelData[0][i]
        let clamped = max(-1.0, min(1.0, Double(sample)))
        int16Array[i] = Int16(clamped * Double(Int16.max))
      }
      data = int16Array.withUnsafeBytes { Data($0) }
      level = enableLevelMeter ? calculateRMS(fromInt16Array: int16Array) : nil
    } else {
      return
    }

    let timestampMs = Date().timeIntervalSince1970 * 1000

    let base64 = data.base64EncodedString()

    let event: [String: Any] = [
      "pcmBase64": base64,
      "sampleRate": sampleRate,
      "timestamp": timestampMs,
      "level": level as Any
    ]

    sendEvent("onFrame", event)

    if bufferingEnabled {
      let pcmCopy = data
      bufferQueue.async {
        self.appendToBuffer(pcmData: pcmCopy, timestampMs: timestampMs)
      }
    }
  }

  private func calculateRMS(fromInt16Buffer int16Pointer: UnsafePointer<Int16>, frameLength: Int) -> Double {
    if frameLength == 0 {
      return 0
    }
    var sum: Double = 0
    for i in 0..<frameLength {
      let sample = Double(int16Pointer[i]) / Double(Int16.max)
      sum += sample * sample
    }
    let mean = sum / Double(frameLength)
    return sqrt(mean)
  }

  private func calculateRMS(fromInt16Array array: [Int16]) -> Double {
    if array.isEmpty {
      return 0
    }
    var sum: Double = 0
    for sampleInt16 in array {
      let sample = Double(sampleInt16) / Double(Int16.max)
      sum += sample * sample
    }
    let mean = sum / Double(array.count)
    return sqrt(mean)
  }

  private func sendError(_ message: String) {
    sendEvent("onError", ["message": message])
  }

  // MARK: - Buffering helpers

  private func appendToBuffer(pcmData: Data, timestampMs: Double) {
    guard bufferingEnabled else { return }
    if currentSegmentWriter == nil {
      currentSegmentWriter = BufferedSegmentWriter(
        directory: bufferDirectory,
        sampleRate: sampleRate,
        startTimestampMs: timestampMs
      )
    }

    guard let writer = currentSegmentWriter else { return }
    writer.append(pcmData: pcmData)

    let dataSize = writer.bytesWritten
    let durationSeconds = Double(dataSize) / (sampleRate * 2.0)
    if durationSeconds >= bufferChunkSeconds {
      finalizeCurrentSegmentIfNeeded()
    }
  }

  private func finalizeCurrentSegmentIfNeeded() {
    guard let writer = currentSegmentWriter else { return }
    guard let info = writer.finalize() else {
      currentSegmentWriter = nil
      return
    }
    currentSegmentWriter = nil
    bufferedSegments.append(info)
    enforceMaxBufferedMinutes()
  }

  private func enforceMaxBufferedMinutes() {
    let maxMs = maxBufferedMinutes * 60_000.0
    var totalMs = bufferedSegments.reduce(0.0) { $0 + $1.durationMs }
    while totalMs > maxMs, !bufferedSegments.isEmpty {
      let oldest = bufferedSegments.removeFirst()
      try? FileManager.default.removeItem(at: oldest.fileURL)
      totalMs = bufferedSegments.reduce(0.0) { $0 + $1.durationMs }
    }
  }
}
