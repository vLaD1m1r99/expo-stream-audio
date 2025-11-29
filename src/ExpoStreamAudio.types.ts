import type { StyleProp, ViewStyle } from "react-native";

export type PermissionStatus = "granted" | "denied" | "undetermined";

export type StreamStatus = "idle" | "recording" | "stopped";

export type StreamAudioOptions = {
  /**
   * Requested sample rate in Hz.
   * The native implementation may fall back to a different rate
   * if the hardware does not support the requested value.
   */
  sampleRate?: 16000 | 44100 | 48000;
  /**
   * Desired frame duration in milliseconds.
   * Native implementations may emit frames with slightly different durations,
   * but will aim to approximate this value.
   *
   * Defaults to 20ms.
   */
  frameDurationMs?: number;
  /**
   * Number of channels. Only mono (1) is supported right now.
   */
  channels?: 1;
  /**
   * When true, native layer will compute a simple power / RMS level
   * for each emitted frame.
   */
  enableLevelMeter?: boolean;
  /**
   * When true (and supported on the platform), the module will
   * try to keep recording while the app is backgrounded by using
   * platform-specific foreground/background audio mechanisms.
   *
   * This is a best-effort flag and does not guarantee that the OS
   * will never suspend the app.
   */
  enableBackground?: boolean;
  /**
   * When true, the native layer will buffer recorded audio into
   * rolling chunks that can be retrieved later as WAV files. This
   * is useful when the realtime WebSocket is disconnected or the
   * app is backgrounded and you want to recover audio afterwards.
   */
  enableBuffering?: boolean;
  /**
   * Target duration for each buffered chunk in seconds.
   * For example, 300 seconds ≈ 5 minutes.
   *
   * Defaults to 300.
   */
  bufferChunkSeconds?: number;
  /**
   * Maximum total buffered duration in minutes. When the total
   * duration of all buffered segments exceeds this limit, the
   * oldest segments will be deleted first.
   *
   * Defaults to 60.
   */
  maxBufferedMinutes?: number;
};

export type BufferedAudioSegment = {
  /**
   * Unique identifier for this buffered segment.
   */
  id: string;
  /**
   * File URI pointing to a WAV file containing PCM16 mono audio.
   */
  uri: string;
  /**
   * Sample rate in Hz used when recording this segment.
   */
  sampleRate: number;
  /**
   * Timestamp in milliseconds since the Unix epoch when this segment started.
   */
  startTimestamp: number;
  /**
   * Approximate duration of this segment in milliseconds.
   */
  durationMs: number;
  /**
   * Size of the WAV file on disk, in bytes.
   */
  sizeBytes: number;
};

export type AudioFrameEvent = {
  /**
   * Base64‑encoded PCM 16‑bit little‑endian audio data.
   * Consumers can decode this to a Uint8Array or Int16Array as needed.
   */
  pcmBase64: string;
  /**
   * Actual sample rate used by the native recorder.
   */
  sampleRate: number;
  /**
   * Timestamp in milliseconds since the Unix epoch.
   */
  timestamp: number;
  /**
   * Optional power / RMS level for the frame.
   */
  level?: number;
};

export type ExpoStreamAudioModuleEvents = {
  onFrame: (event: AudioFrameEvent) => void;
  onError: (event: { message: string }) => void;
};

// Legacy view props (not used by the module exports, but kept
// to avoid breaking the generated view files and typings).
export type OnLoadEventPayload = {
  url: string;
};

export type ExpoStreamAudioViewProps = {
  url: string;
  onLoad: (event: { nativeEvent: OnLoadEventPayload }) => void;
  style?: StyleProp<ViewStyle>;
};
