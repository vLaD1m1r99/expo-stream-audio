import * as React from 'react';

import { ExpoStreamAudioViewProps } from './ExpoStreamAudio.types';

export default function ExpoStreamAudioView(props: ExpoStreamAudioViewProps) {
  return (
    <div>
      <iframe
        style={{ flex: 1 }}
        src={props.url}
        onLoad={() => props.onLoad({ nativeEvent: { url: props.url } })}
      />
    </div>
  );
}
