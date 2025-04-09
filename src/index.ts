import { SAMPLE_RATE } from './constants';
import * as audio from './audio';
import * as ui from './ui';

// not a real error -- see https://v3.vitejs.dev/guide/assets.html
import workletUrl from './worklet.ts?url';
import { MessageFromWorklet, UiState } from './types';

const context = new AudioContext({
  latencyHint: 'balanced',
  sampleRate: SAMPLE_RATE,
});

await context.audioWorklet.addModule(workletUrl);
const looper = makeLooper();
await audio.init(context, looper);

const state: UiState = {
  shared: { layers: [] },
  samplesAsFloats: new Map(),
  playhead: 0,
};

ui.init(looper, state);

function makeLooper() {
  const looper = new AudioWorkletNode(context, 'looper');
  looper.port.onmessage = (msg) => {
    const m = msg.data as MessageFromWorklet;
    switch (m.event) {
      case 'playhead moved':
        state.playhead = m.value;
        break;
      case 'finished recording':
        state.shared.layers.push({ ...m.layer, samples: new Uint8Array(m.samples) });
        state.samplesAsFloats.set(m.layer.id, new Float32Array(m.samples));
        break;
      default:
        console.info('worklet:', m);
    }
  };
  return looper;
}
