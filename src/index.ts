import { SAMPLE_RATE } from './constants';
import * as audio from './audio';
import * as ui from './ui';

// not a real error -- see https://v3.vitejs.dev/guide/assets.html
import workletUrl from './worklet.ts?url';
import { LooperState, MessageFromWorklet, MessageToWorklet, UiState } from './types';

const context = new AudioContext({
  latencyHint: 'balanced',
  sampleRate: SAMPLE_RATE,
});

await context.audioWorklet.addModule(workletUrl);
const looper = new AudioWorkletNode(context, 'looper');
await audio.init(context, looper);

const state: UiState = {
  shared: { layers: [] },
  samplesAsFloats: new Map(),
  playhead: 0,
};

ui.init(looper, state, changeSharedState);

function changeSharedState(fn: (state: LooperState) => void) {
  fn(state.shared);
  sendToWorklet({ command: 'update layers', layers: state.shared.layers });
}

function sendToWorklet(msg: MessageToWorklet) {
  looper.port.postMessage(msg);
}
