import { SAMPLE_RATE } from './constants';
import * as audio from './audio';
import * as ui from './ui';

// not a real error -- see https://v3.vitejs.dev/guide/assets.html
import workletUrl from './worklet.ts?url';

const context = new AudioContext({
  latencyHint: 'balanced',
  sampleRate: SAMPLE_RATE,
});

await context.audioWorklet.addModule(workletUrl);
const looper = makeLooper();
await audio.init(context, looper);
ui.init(looper);

function makeLooper() {
  const looper = new AudioWorkletNode(context, 'looper');
  looper.port.onmessage = (msg) => {
    console.log('worklet:', msg.data);
  };
  looper.onprocessorerror = (e) => {
    console.error('worklet error:', e);
    throw new Error(e.message);
  };
  return looper;
}
