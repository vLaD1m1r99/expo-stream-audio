// Config plugin for expo-stream-audio
// Automatically configures iOS and Android permissions when added to `plugins`.

const {
  withInfoPlist,
  withAndroidManifest,
  createRunOncePlugin,
} = require("@expo/config-plugins");

const pkg = require("./package.json");

const IOS_MIC_MESSAGE =
  "Allow this app to access the microphone for streaming audio.";

const withExpoStreamAudio = (config) => {
  // iOS: ensure microphone usage description and background audio mode.
  config = withInfoPlist(config, (config) => {
    const plist = config.modResults;

    if (!plist.NSMicrophoneUsageDescription) {
      plist.NSMicrophoneUsageDescription = IOS_MIC_MESSAGE;
    }

    const modes = Array.isArray(plist.UIBackgroundModes)
      ? plist.UIBackgroundModes
      : plist.UIBackgroundModes
      ? [plist.UIBackgroundModes]
      : [];

    if (!modes.includes("audio")) {
      plist.UIBackgroundModes = [...modes, "audio"];
    }

    return config;
  });

  // Android: ensure microphone + foreground service permissions.
  config = withAndroidManifest(config, (config) => {
    const manifest = config.modResults;
    const usesPermissions = manifest.manifest["uses-permission"] ?? [];

    const ensurePermission = (name) => {
      if (!usesPermissions.some((p) => p.$["android:name"] === name)) {
        usesPermissions.push({ $: { "android:name": name } });
      }
    };

    ensurePermission("android.permission.RECORD_AUDIO");
    ensurePermission("android.permission.FOREGROUND_SERVICE");
    ensurePermission("android.permission.FOREGROUND_SERVICE_MICROPHONE");

    manifest.manifest["uses-permission"] = usesPermissions;
    return config;
  });

  return config;
};

module.exports = createRunOncePlugin(
  withExpoStreamAudio,
  pkg.name,
  pkg.version,
);

