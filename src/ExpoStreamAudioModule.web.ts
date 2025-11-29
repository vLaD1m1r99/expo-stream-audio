import { NativeModule, registerWebModule } from "expo";

import type {
  ExpoStreamAudioModuleEvents,
  PermissionStatus,
  StreamAudioOptions,
  StreamStatus,
} from "./ExpoStreamAudio.types";

class ExpoStreamAudioModule extends NativeModule<ExpoStreamAudioModuleEvents> {
  async requestPermission(): Promise<PermissionStatus> {
    console.warn("[expo-stream-audio] requestPermission is not supported on web.");
    return "denied";
  }

  async start(_options?: StreamAudioOptions): Promise<void> {
    console.warn("[expo-stream-audio] start is not supported on web.");
  }

  async stop(): Promise<void> {
    console.warn("[expo-stream-audio] stop is not supported on web.");
  }

  async getStatus(): Promise<StreamStatus> {
    return "idle";
  }
}

export default registerWebModule(ExpoStreamAudioModule, "ExpoStreamAudioModule");
