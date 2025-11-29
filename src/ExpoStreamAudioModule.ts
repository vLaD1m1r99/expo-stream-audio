import { NativeModule, requireNativeModule } from "expo";

import type {
  ExpoStreamAudioModuleEvents,
  StreamAudioOptions,
  PermissionStatus,
  StreamStatus,
  AudioFrameEvent,
  BufferedAudioSegment,
} from "./ExpoStreamAudio.types";

declare class ExpoStreamAudioModule extends NativeModule<ExpoStreamAudioModuleEvents> {
  requestPermission(): Promise<PermissionStatus>;
  start(options?: StreamAudioOptions): Promise<void>;
  stop(): Promise<void>;
  getStatus(): Promise<StreamStatus>;
  setBufferingEnabled(enabled: boolean): Promise<void>;
  getBufferedSegments(): Promise<BufferedAudioSegment[]>;
  clearBufferedSegments(): Promise<void>;
}

// This call loads the native module object from the JSI.
const module = requireNativeModule<ExpoStreamAudioModule>("ExpoStreamAudio");

export type {
  StreamAudioOptions,
  PermissionStatus,
  StreamStatus,
  AudioFrameEvent,
  BufferedAudioSegment,
  ExpoStreamAudioModuleEvents,
};

export default module;
