import streamAudioModule, {
  type AudioFrameEvent,
  type ExpoStreamAudioModuleEvents,
  type PermissionStatus,
  type StreamAudioOptions,
  type StreamStatus,
  type BufferedAudioSegment,
} from "./ExpoStreamAudioModule";

export type Subscription = { remove: () => void };

export type {
  AudioFrameEvent,
  PermissionStatus,
  StreamAudioOptions,
  StreamStatus,
  BufferedAudioSegment,
  ExpoStreamAudioModuleEvents,
};

/**
 * Request microphone permission on the current platform.
 * Note: On Android this currently reports the status and expects
 * the host app to request permissions if needed.
 */
export function requestPermission(): Promise<PermissionStatus> {
  return streamAudioModule.requestPermission();
}

/**
 * Start streaming microphone audio from the native layer.
 */
export function start(options?: StreamAudioOptions): Promise<void> {
  return streamAudioModule.start(options ?? {});
}

/**
 * Stop streaming microphone audio.
 */
export function stop(): Promise<void> {
  return streamAudioModule.stop();
}

/**
 * Get the current streaming status.
 */
export function getStatus(): Promise<StreamStatus> {
  return streamAudioModule.getStatus();
}

/**
 * Enable or disable native buffering at runtime while recording
 * is active. When enabled, subsequent frames will be written into
 * rolling WAV segments until disabled again.
 */
export function setBufferingEnabled(enabled: boolean): Promise<void> {
  return streamAudioModule.setBufferingEnabled(enabled);
}

/**
 * Retrieve metadata for all buffered audio segments currently
 * stored on disk by the native layer.
 */
export function getBufferedSegments(): Promise<BufferedAudioSegment[]> {
  return streamAudioModule.getBufferedSegments();
}

/**
 * Remove all buffered audio segments and delete their underlying
 * files from disk.
 */
export function clearBufferedSegments(): Promise<void> {
  return streamAudioModule.clearBufferedSegments();
}

/**
 * Subscribe to audio frame events.
 * Returns an Expo Subscription that can be removed when no longer needed.
 */
export function addFrameListener(listener: (event: AudioFrameEvent) => void): Subscription {
  return streamAudioModule.addListener("onFrame", listener);
}

/**
 * Subscribe to error events emitted by the native layer.
 */
export function addErrorListener(listener: (event: { message: string }) => void): Subscription {
  return streamAudioModule.addListener("onError", listener);
}
