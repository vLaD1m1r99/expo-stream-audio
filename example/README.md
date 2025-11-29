# expo-stream-audio example app

This is a small demo app that shows how to use `expo-stream-audio` as a native mic source for ElevenLabs Scribe v2 Realtime.

It is designed to run in a **development build** (not Expo Go) for both iOS and Android.

---

## Setup

1. Install dependencies:

```bash
cd example
npm install
```

2. Configure ElevenLabs API key:

```bash
cp .env.example .env
```

Then edit `.env` and set:

```bash
EXPO_PUBLIC_ELEVENLABS_API_KEY=your_elevenlabs_api_key_here
```

Do **not** commit a real API key.

---

## Running the app

You must use a dev build (or EAS build). Expo Go will not work because `expo-stream-audio` is a native module.

From the `example` directory:

```bash
npm run ios
```

```bash
npm run android
```

These commands will:

- Run `expo run:ios` / `expo run:android` to build and install the dev client.
- Connect the dev client to Metro so you can see logs and live reload JS.

---

## What the example does

The app is structured into three tabs:

- **Realtime** – controls the native mic stream and Scribe connection:
  - Shows mic and Scribe connection status.
  - Lets you start/stop the stream with a single primary button.
  - When an API key is detected, the setup step is marked complete.

- **Transcript** – shows the live transcript:
  - A live indicator (“Streaming live” / “Not streaming”).
  - A fixed-height transcript area that auto-scrolls as new text arrives.
  - Each committed segment can show:
    - Start time (mm:ss) from ElevenLabs timestamps.
    - Speaker ID (if provided by ElevenLabs).
  - A softer “partial” line at the bottom for the current in-progress transcript.
  - When no transcript exists yet, the card offers a “Start Stream” button and a short hint.

- **Debug** – low-level info:
  - Mic sample rate and last frame timestamp.
  - A simple RMS level meter.
  - A log area that shows errors / important messages.
  - A short description of how buffered audio behaves when Scribe disconnects.

---

## Notes

- The example app depends on the published `expo-stream-audio` package from npm (via `example/package.json`), not a local file link.
- The `plugins: ["expo-stream-audio"]` entry in `example/app.json` enables the config plugin, which:
  - Adds mic + background audio permissions on iOS.
  - Adds mic + foreground service permissions on Android.
- Because `expo-stream-audio` is a native module, you **must** rebuild the native app (via `expo run:*` or EAS) anytime you add/remove the dependency or change plugins.

