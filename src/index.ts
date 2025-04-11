import { SAMPLE_RATE } from './constants';
import { LooperState, MessageToWorklet, UiState } from './types';
import * as audio from './audio';
import * as ui from './ui';

// not a real error -- see https://v3.vitejs.dev/guide/assets.html
import workletUrl from './worklet.ts?worker&url';

const context = new AudioContext({
  latencyHint: 'balanced',
  sampleRate: SAMPLE_RATE,
});

await context.audioWorklet.addModule(workletUrl);
const looper = new AudioWorkletNode(context, 'looper');
const inputDeviceId = await audio.init(context, looper);

const knownLayerIds = new Set<number>();
const state: UiState = { shared: { layers: [] }, playhead: 0 };

ui.init(looper, inputDeviceId, state, changeSharedState);

function sendToWorklet(msg: MessageToWorklet) {
  looper.port.postMessage(msg);
}

// --- Automerge stuff ---

// import { getActorId } from '@automerge/automerge';
import { DocHandle, isValidAutomergeUrl, Repo } from '@automerge/automerge-repo';
import { IndexedDBStorageAdapter } from '@automerge/automerge-repo-storage-indexeddb';
import { BrowserWebSocketClientAdapter } from '@automerge/automerge-repo-network-websocket';
import { copyWithoutSamples } from './helpers';

const repo = new Repo({
  storage: new IndexedDBStorageAdapter('automerge-demo'),
  network: [new BrowserWebSocketClientAdapter('wss://sync.automerge.org')],
});

const handle = await initDoc();

handle.on('change', (payload) => onNewState(payload.doc));

function onNewState(sharedState: LooperState) {
  // console.log('new state', sharedState);
  state.shared = sharedState;
  sendToWorklet({ command: 'update layers', layers: state.shared.layers.map(copyWithoutSamples) });
  sendNewLayerSamplesToWorklet();
}

function sendNewLayerSamplesToWorklet() {
  for (const layer of state.shared.layers) {
    if (knownLayerIds.has(layer.id)) {
      continue;
    }

    knownLayerIds.add(layer.id);
    const samples = new Float32Array(layer.samples.buffer);
    sendToWorklet({ command: 'set layer samples', id: layer.id, samples });
  }
}

function changeSharedState(fn: (state: LooperState) => void) {
  handle.change(fn);
}

async function initDoc() {
  const docUrl = document.location.hash.substring(1);
  let handle: DocHandle<LooperState>;
  if (isValidAutomergeUrl(docUrl)) {
    console.log('loading existing doc');
    handle = repo.find(docUrl);
    onNewState((await handle.doc()) as LooperState);
  } else {
    console.log('creating new doc');
    const newState = state.shared;
    handle = repo.create<LooperState>(newState);
    document.location.hash = handle.url;
    onNewState(newState);
  }
  return handle;
}
