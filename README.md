# expo-stream-audio

`expo-stream-audio` is a small Expo module that streams microphone audio from native code into JavaScript as **PCM 16‑bit mono** frames. It is designed to be the “audio source” for realtime speech‑to‑text or other streaming use‑cases (for example ElevenLabs Scribe v2 Realtime).

The module itself is intentionally minimal:

- No built‑in networking or AI integration.
- Just mic → PCM frames → JS events.

An example app is included under `example/` that wires this module to ElevenLabs Scribe v2 Realtime using `@elevenlabs/client`.  
You can find it in the GitHub repo here: https://github.com/vLaD1m1r99/expo-stream-audio (see the `example/` folder).

---

## Installation

> This is a **native module**. It does **not** work in Expo Go – use a development build (`expo run:ios` / `expo run:android`) or a custom/EAS build.

### Quick start (Expo apps)

Target: Expo SDK 54 / React Native 0.81.

1. Install the package:

```bash
npx expo install expo-stream-audio
```

2. Add the config plugin to your Expo config:

```jsonc
// app.json / app.config.(js|ts)
{
  "expo": {
    "plugins": ["expo-stream-audio"]
  }
}
```

3. Rebuild a development build so native code is included:

```bash
npx expo run:ios
```

```bash
npx expo run:android
```

After the first native rebuild, you can iterate on JS with fast refresh, but any changes to native modules or plugins require another rebuild.

### Bare React Native / custom Expo prebuild

If you are in a bare React Native app (or using Expo prebuild manually), install from npm:

```bash
npm install expo-stream-audio
```

And make sure you have the `expo` package installed and configured for Expo Modules:

```bash
npm install expo
```

Then run prebuild so native projects pick up the module:

```bash
npx expo prebuild
```

Because `expo-stream-audio` is a **native module**, you must rebuild your app after adding or removing it for the native changes to take effect. Metro fast refresh alone is not enough.

### What the config plugin does

If you enable the plugin (`"plugins": ["expo-stream-audio"]`), running `npx expo prebuild` / `expo run:*` will automatically:

- Ensure `NSMicrophoneUsageDescription` and background audio (`UIBackgroundModes = ["audio"]`) are set on iOS.
- Add `RECORD_AUDIO`, `FOREGROUND_SERVICE`, and `FOREGROUND_SERVICE_MICROPHONE` permissions on Android.

### iOS

After installing:

```bash
npx pod-install
```

In your own app, you must define at least `NSMicrophoneUsageDescription` in your Info.plist (or via `app.json` / `app.config.ts`).

The example app’s `Info.plist` also enables background audio:

```xml
<key>NSMicrophoneUsageDescription</key>
<string>Allow this app to access the microphone for audio streaming tests.</string>
<key>UIBackgroundModes</key>
<array>
  <string>audio</string>
</array>
```

### Android

The module needs microphone access and, if you want long‑running capture, foreground service permissions. The example app declares:

```jsonc
"android": {
  "permissions": [
    "RECORD_AUDIO",
    "FOREGROUND_SERVICE",
    "FOREGROUND_SERVICE_MICROPHONE"
  ]
}
```

In a bare app, add the same entries to `AndroidManifest.xml` or to your Expo config.

---

## JavaScript API

The module exports a small, imperative API from `expo-stream-audio`:

```ts
import {
  requestPermission,
  start,
  stop,
  getStatus,
  addFrameListener,
  addErrorListener,
} from "expo-stream-audio";
```

### Types

```ts
type PermissionStatus = "granted" | "denied" | "undetermined";
type StreamStatus = "idle" | "recording" | "stopped";

type AudioFrameEvent = {
  // Base64-encoded PCM 16-bit little-endian mono audio
  pcmBase64: string;
  // Actual sample rate used by the native recorder
  sampleRate: number;
  // Timestamp in ms since Unix epoch
  timestamp: number;
  // Optional RMS level for the frame (0–1)
  level?: number;
};
```

### `requestPermission(): Promise<PermissionStatus>`

Checks microphone permission:

- iOS: wraps `AVAudioSession.recordPermission`.
- Android: wraps `ContextCompat.checkSelfPermission(RECORD_AUDIO)`.

On Android you should still explicitly call `PermissionsAndroid.request` if not granted. The example app demonstrates this.

### `start(options?: StreamAudioOptions): Promise<void>`

Starts native microphone capture and begins emitting `onFrame` events.

Key options:

- `sampleRate?: 16000 | 44100 | 48000` – default `16000`
- `frameDurationMs?: number` – default `20` (ms)
- `channels?: 1` – mono only for now
- `enableLevelMeter?: boolean` – compute RMS level per frame
- `enableBackground?: boolean` – best‑effort background recording with a foreground service on Android and background audio session on iOS
- `enableBuffering?: boolean` – enable/disable **on‑device WAV buffering** (see below)
- `bufferChunkSeconds?: number` – target length of each buffered WAV chunk in seconds (default `300` ≈ 5 minutes)
- `maxBufferedMinutes?: number` – maximum total buffered duration in minutes before oldest chunks are dropped (default `60`)

On iOS, `start` configures `AVAudioSession` and uses `AVAudioEngine` input taps.  
On Android, `start` configures an `AudioRecord` on a background thread using a voice‑optimized audio source (`VOICE_RECOGNITION`, `VOICE_COMMUNICATION`, then `MIC` as fallback).

### `stop(): Promise<void>`

Stops native recording, tears down the audio engine / AudioRecord, and stops emitting frames.

### `getStatus(): Promise<StreamStatus>`

Returns `"recording"` or `"idle"` depending on whether native capture is active.

### `addFrameListener(listener: (event: AudioFrameEvent) => void)`

Subscribes to audio frame events. Returns a subscription object with `.remove()`:

```ts
const sub = addFrameListener(frame => {
  console.log(frame.sampleRate, frame.timestamp, frame.level);
  // frame.pcmBase64 contains PCM16 mono audio you can send over WebSocket
});

// later
sub.remove();
```

### `addErrorListener(listener: (event: { message: string }) => void)`

Subscribes to error events emitted by the native layer.  
For example, Android may report `AudioRecord read error code: -3` if the stream fails.

### Buffered audio helpers

When buffering is enabled (either at `start` time or later via `setBufferingEnabled(true)`), the native layer writes audio into rolling **WAV** files that you can upload to a batch STT endpoint later.

- `setBufferingEnabled(enabled: boolean): Promise<void>`  
  Turn native buffering on or off at runtime while recording.

- `getBufferedSegments(): Promise<BufferedAudioSegment[]>`

  Each segment:

  ```ts
  type BufferedAudioSegment = {
    id: string
    uri: string          // file://... WAV file
    sampleRate: number
    startTimestamp: number // ms since Unix epoch
    durationMs: number
    sizeBytes: number
  }
  ```

- `clearBufferedSegments(): Promise<void>`  
  Deletes all buffered WAV files and clears internal metadata.

---

## Basic usage example

```ts
import { useEffect, useRef, useState } from "react";
import {
  requestPermission,
  start,
  stop,
  addFrameListener,
  addErrorListener,
  type AudioFrameEvent,
} from "expo-stream-audio";
import { Button, PermissionsAndroid, Platform, Text, View } from "react-native";

export function MicStreamTest() {
  const [status, setStatus] = useState("idle");
  const [lastFrame, setLastFrame] = useState<AudioFrameEvent | null>(null);
  const frameSubRef = useRef<{ remove: () => void } | null>(null);
  const errorSubRef = useRef<{ remove: () => void } | null>(null);

  useEffect(() => {
    return () => {
      frameSubRef.current?.remove();
      errorSubRef.current?.remove();
      stop().catch(() => {});
    };
  }, []);

  const handleStart = async () => {
    let permission = await requestPermission();

    if (Platform.OS === "android" && permission !== "granted") {
      const result = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
      );
      if (result === PermissionsAndroid.RESULTS.GRANTED) {
        permission = "granted";
      }
    }

    if (Platform.OS === "ios" && permission === "undetermined") {
      // allow native code to show the system mic prompt
      permission = "granted";
    }

    if (permission !== "granted") {
      return;
    }

    frameSubRef.current?.remove();
    errorSubRef.current?.remove();

    frameSubRef.current = addFrameListener((frame: AudioFrameEvent) => {
      setLastFrame(frame);
    });

    errorSubRef.current = addErrorListener(event => {
      console.warn("Mic error", event.message);
    });

    await start({
      sampleRate: 16000,
      frameDurationMs: 20,
      enableLevelMeter: true,
    });
    setStatus("recording");
  };

  const handleStop = async () => {
    frameSubRef.current?.remove();
    errorSubRef.current?.remove();
    await stop();
    setStatus("stopped");
  };

  return (
    <View>
      <Text>Status: {status}</Text>
      <Button title="Start" onPress={handleStart} />
      <Button title="Stop" onPress={handleStop} />
      {lastFrame ? (
        <Text>
          {lastFrame.sampleRate} Hz – level={lastFrame.level?.toFixed(6) ?? "n/a"}
        </Text>
      ) : (
        <Text>No frames yet</Text>
      )}
    </View>
  );
}
```

---

## Example: wiring to ElevenLabs Scribe v2 Realtime

The example app under `example/` shows how to connect this module to ElevenLabs Scribe v2 Realtime using `@elevenlabs/client`:

- Use `expo-stream-audio` to get PCM16 frames on native.
- Fetch a Scribe token (for local testing the example calls the ElevenLabs token endpoint directly; in production you should do this on your server).
- Call `Scribe.connect({ token, modelId: "scribe_v2_realtime", audioFormat: AudioFormat.PCM_16000, sampleRate: 16000, commitStrategy: CommitStrategy.VAD, ... })`.
- On each `AudioFrameEvent`, call `connection.send({ audioBase64: frame.pcmBase64, sampleRate: frame.sampleRate })`.
- Listen for `RealtimeEvents.PARTIAL_TRANSCRIPT` and `COMMITTED_TRANSCRIPT` to update your UI and/or forward transcripts to your backend.

This keeps `expo-stream-audio` focused on audio capture and lets you plug in any realtime STT backend that accepts PCM16 audio.

---

## Status / Limitations

- Tested with Expo SDK 54 and React Native 0.81.
- PCM16 mono only; stereo and other formats are not currently supported.
- Android audio behavior can vary by device/emulator. Some emulators may feed silence after a short period; physical devices are recommended for accurate testing.
- Background recording + buffering:
  - Native audio capture and WAV buffering can continue while the app is backgrounded, but JS and WebSocket code may still be paused or killed by the OS.
  - Use the buffered segment APIs to “catch up” later by sending WAV files to your backend or a batch STT endpoint when the app returns to foreground.

---

## Contributing

This module started as an internal tool for testing realtime STT pipelines on Expo/React Native.  
If you want to extend it (stereo support, configurable sources, foreground service scaffolding, etc.), contributions are welcome.
