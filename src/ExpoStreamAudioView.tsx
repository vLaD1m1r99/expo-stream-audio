import { requireNativeView } from 'expo';
import * as React from 'react';

import { ExpoStreamAudioViewProps } from './ExpoStreamAudio.types';

const NativeView: React.ComponentType<ExpoStreamAudioViewProps> =
  requireNativeView('ExpoStreamAudio');

export default function ExpoStreamAudioView(props: ExpoStreamAudioViewProps) {
  return <NativeView {...props} />;
}
