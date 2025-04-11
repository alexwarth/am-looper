// TODO: clean up the mess that I made w/ devicePixelRatio
// (I want pointer coordinates to match up with screen coordinates)

import { NUM_FRAMES_PER_CHUNK } from './constants';
import { getLengthInFrames } from './helpers';
import { loadPersistentState, changePersistentState } from './persistence';
import {
  Layer,
  LooperState,
  MessageFromWorklet,
  MessageToWorklet,
  Position,
  UiState,
} from './types';

let looper: AudioWorkletNode;
let inputDeviceId: string;
let state: UiState;
let changeSharedState: (fn: (state: LooperState) => void) => void;

export function init(
  _looper: AudioWorkletNode,
  _inputDeviceId: string,
  _state: UiState,
  _changeSharedState: (fn: (state: LooperState) => void) => void,
) {
  looper = _looper;
  (window as any).looper = looper;
  inputDeviceId = _inputDeviceId;
  state = _state;
  changeSharedState = _changeSharedState;

  looper.port.onmessage = (msg) => onMessage(msg.data);

  const latencyOffset = loadPersistentState().deviceSpecificLatencyOffset[inputDeviceId] ?? 20;
  sendToWorklet({ command: 'set latency offset', value: latencyOffset });

  // keyboard
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  // mouse
  window.addEventListener('pointermove', (e) =>
    onPointerMove(e.x / devicePixelRatio, e.y / devicePixelRatio),
  );

  function onFrame() {
    render();
    requestAnimationFrame(onFrame);
  }
  onFrame();

  displayRecordingHelp();
}

function sendToWorklet(m: MessageToWorklet) {
  looper.port.postMessage(m);
}

function onMessage(m: MessageFromWorklet) {
  switch (m.event) {
    case 'playhead moved':
      state.playhead = m.value;
      break;
    case 'finished recording':
      changeSharedState((state) => {
        state.layers.push({ ...m.layer, samples: new Uint8Array(m.samples) });
      });
      break;
    case 'changed latency offset':
      displayStatus(`latency offset = ${m.value}`);
      changePersistentState((state) => {
        state.deviceSpecificLatencyOffset[inputDeviceId] = m.value;
      });
      break;
    default:
      console.info('worklet:', m);
  }
}

function changeLayer(id: number | null, fn: (layer: Layer) => void) {
  if (id === null) {
    return;
  }

  changeSharedState((state) => {
    const layer = state.layers.find((layer) => layer.id === id);
    if (layer) {
      fn(layer);
    }
  });
}

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;

// --- resize handling ---

updateCanvasSize();

function updateCanvasSize() {
  canvas.width = innerWidth;
  canvas.height = innerHeight;

  // setup the canvas for device-independent pixels
  if (devicePixelRatio !== 1) {
    const oldW = canvas.width;
    const oldH = canvas.height;
    canvas.width = oldW * devicePixelRatio;
    canvas.height = oldH * devicePixelRatio;
    canvas.style.width = oldW + 'px';
    canvas.style.height = oldH + 'px';
    ctx.scale(devicePixelRatio, devicePixelRatio);
  }
}

window.addEventListener('resize', updateCanvasSize);

// --- keyboard controls ---

let spaceIsDown = false;

function onKeyDown(e: KeyboardEvent) {
  switch (e.key) {
    case ' ':
      if (!spaceIsDown) {
        spaceIsDown = true;
        toggleRecording();
      }
      break;
    case 'Backspace':
      deleteLayer();
      break;
    case 'd':
      duplicateLayer();
      break;
    case 'm':
      toggleMuted();
      break;
    case 's':
      toggleSoloed();
      break;
    case 'Shift':
      onShift('down');
      break;
    case 'Control':
      onControl('down');
    case 'ArrowUp':
    case 'ArrowDown':
      changeLatencyOffsetBy(e.key === 'ArrowUp' ? 1 : -1);
      break;
  }
}

function onKeyUp(e: KeyboardEvent) {
  switch (e.key) {
    case ' ':
      spaceIsDown = false;
      break;
    case 'Shift':
      onShift('up');
      break;
    case 'Control':
      onControl('up');
      break;
  }
}

let recording = false;

function toggleRecording() {
  if (recording) {
    sendToWorklet({ command: 'stop recording' });
    recording = false;
    displayStatus('stopped recording', '#888');
  } else {
    sendToWorklet({ command: 'start recording' });
    recording = true;
    displayStatus('recording...', 'red');
  }
  displayRecordingHelp();
}

function deleteLayer() {
  const id = getLayerAtPointer();
  if (id !== null) {
    changeSharedState((state) => {
      const idx = state.layers.findIndex((layer) => layer.id === id);
      if (idx >= 0) {
        state.layers.splice(idx, 1);
      }
    });
  }
}

function duplicateLayer() {
  const id = getLayerAtPointer();
  if (id !== null) {
    changeSharedState((state) => {
      const idx = state.layers.findIndex((layer) => layer.id === id);
      if (idx < 0) {
        return;
      }
      const layer = state.layers[idx];
      state.layers.splice(idx, 0, { ...layer, id: Math.random() });
    });
  }
}

function toggleMuted() {
  changeLayer(getLayerAtPointer(), (layer) => {
    layer.muted = !layer.muted;
  });
}

function toggleSoloed() {
  changeLayer(getLayerAtPointer(), (layer) => {
    layer.soloed = !layer.soloed;
  });
}

let gainChangeLayerInfo: { id: number; origGain: number; origPos: Position } | null = null;

function onControl(control: 'down' | 'up') {
  if (control === 'up') {
    gainChangeLayerInfo = null;
    return;
  }

  const id = getLayerAtPointer();
  if (id === null) {
    gainChangeLayerInfo = null;
    return;
  }

  const layer = state.shared.layers.find((layer) => layer.id === id)!;
  gainChangeLayerInfo = { id, origGain: layer.gain, origPos: { ...pointerPos } };
}

let offsetChangeLayerInfo: { id: number; origOffset: number; origPos: Position } | null = null;

function onShift(shift: 'down' | 'up') {
  if (shift === 'up') {
    offsetChangeLayerInfo = null;
    return;
  }

  const id = getLayerAtPointer();
  if (id === null) {
    offsetChangeLayerInfo = null;
    return;
  }

  const layer = state.shared.layers.find((layer) => layer.id === id)!;
  offsetChangeLayerInfo = { id, origOffset: layer.frameOffset, origPos: { ...pointerPos } };
}

function changeLatencyOffsetBy(increment: number) {
  sendToWorklet({ command: 'change latency offset', by: increment });
}

// --- mouse controls ---

const pointerPos = { x: 0, y: 0 };

function onPointerMove(x: number, y: number) {
  pointerPos.x = x;
  pointerPos.y = y;

  if (gainChangeLayerInfo !== null) {
    const { id, origPos, origGain } = gainChangeLayerInfo;
    changeLayer(id, (layer) => {
      const change = -(pointerPos.y - origPos.y);
      layer.gain = Math.max(0, Math.min(origGain + change / unitGainNubbinRadius, 2));
    });
  }

  if (offsetChangeLayerInfo !== null) {
    const { id, origPos, origOffset } = offsetChangeLayerInfo;
    changeLayer(id, (layer) => {
      const change = pointerPos.x - origPos.x;
      layer.frameOffset = Math.round(origOffset + (change * devicePixelRatio) / pixelsPerFrame);
    });
  }
}

function getLayerAtPointer() {
  for (const l of state.shared.layers) {
    const { topY, bottomY } = getAddlInfo(l);
    if (topY <= pointerPos.y && pointerPos.y <= bottomY) {
      return l.id;
    }
  }
  return null;
}

// --- UI-related info for each layer ---

interface AddlLayerInfo {
  maxAmplitudesInChunks: number[];
  maxAmplitudeInLayer: number;
  gainNubbinCenterPosition: Position;
  topY: number;
  bottomY: number;
}

const addlLayerInfoById = new Map<number, AddlLayerInfo>();

function getAddlInfo(layer: Layer) {
  let addlInfo = addlLayerInfoById.get(layer.id);
  if (addlInfo) {
    return addlInfo;
  }

  const samples = new Float32Array(layer.samples.buffer);
  const maxAmplitudesInChunks: number[] = [];
  let maxAmplitudeInLayer = 0;
  let sampleIdx = 0;
  while (sampleIdx < samples.length) {
    let maxAmplitudeInChunk = 0;
    for (let f = 0; f < NUM_FRAMES_PER_CHUNK; f++) {
      for (let c = 0; c < layer.numChannels; c++) {
        if (sampleIdx > samples.length) {
          throw new Error('uh-oh: not enough samples in layer w/ id ' + layer.id);
        }
        maxAmplitudeInChunk = Math.max(maxAmplitudeInChunk, Math.abs(samples[sampleIdx++]));
      }
    }
    maxAmplitudesInChunks.push(maxAmplitudeInChunk);
    maxAmplitudeInLayer = Math.max(maxAmplitudeInLayer, maxAmplitudeInChunk);
  }

  addlInfo = {
    maxAmplitudesInChunks,
    maxAmplitudeInLayer,
    gainNubbinCenterPosition: { x: 0, y: 0 },
    topY: 0,
    bottomY: 0,
  };
  addlLayerInfoById.set(layer.id, addlInfo);
  return addlInfo;
}

// --- rendering ---

const GAIN_NUBBIN_SPACING = 100;
const LAYER_HEIGHT_IN_PIXELS = 30;

let lengthInFrames: number | null = null;
let pixelsPerFrame = 1;
let layerHeightInPixels = 32;
let unitGainNubbinRadius = layerHeightInPixels / 2;

function render() {
  layerHeightInPixels = LAYER_HEIGHT_IN_PIXELS; // TODO: calculate this based on the layers
  unitGainNubbinRadius = Math.ceil(layerHeightInPixels / 2);
  lengthInFrames = getLengthInFrames(state.shared.layers);
  if (lengthInFrames !== null) {
    pixelsPerFrame = (innerWidth - 2 * GAIN_NUBBIN_SPACING) / lengthInFrames;
  }
  ctx.clearRect(0, 0, innerWidth, innerHeight);
  renderLayers();
  renderLogs();
  renderStatus();
}

function renderLayers() {
  if (lengthInFrames === null) {
    return;
  }

  const layers = state.shared.layers;
  let top = 2 * layerHeightInPixels;
  const x0 = GAIN_NUBBIN_SPACING;
  const x1 = x0 + lengthInFrames * pixelsPerFrame;
  for (let idx = 0; idx < layers.length; idx++) {
    const layer = layers[idx];
    const addlInfo = getAddlInfo(layer);
    const alpha = layer.muted ? 0.25 : 1;
    let maxY = top;

    // draw samples
    const rgb = layer.soloed ? `50, 75, 117` : `100, 149, 237`;
    const sampleColor = `rgba(${rgb}, ${alpha})`;
    ctx.strokeStyle = sampleColor;
    ctx.lineWidth = NUM_FRAMES_PER_CHUNK * pixelsPerFrame;
    for (let rep = 0; rep < layer.numFramesRecorded / lengthInFrames; rep++) {
      let y = top;
      let x = x0 + ((layer.frameOffset + lengthInFrames) % lengthInFrames) * pixelsPerFrame;
      for (let chunkIdx = 0; chunkIdx < addlInfo.maxAmplitudesInChunks.length; chunkIdx++) {
        if (x >= x1) {
          x = x0;
          y += layerHeightInPixels;
        }
        const amplitude =
          (((addlInfo.maxAmplitudesInChunks[chunkIdx] / addlInfo.maxAmplitudeInLayer) *
            layerHeightInPixels) /
            2) *
          layer.gain;
        ctx.beginPath();
        ctx.moveTo(x, y - amplitude / 2);
        ctx.lineTo(x, y + amplitude / 2);
        ctx.stroke();
        x += NUM_FRAMES_PER_CHUNK * pixelsPerFrame;
      }
      maxY = y;
    }

    const centerX = GAIN_NUBBIN_SPACING / 2;
    const centerY = (top + maxY) / 2;

    addlInfo.gainNubbinCenterPosition = {
      x: centerX / devicePixelRatio,
      y: centerY / devicePixelRatio,
    };
    addlInfo.topY = (top - layerHeightInPixels / 2) / devicePixelRatio;
    addlInfo.bottomY = (maxY + layerHeightInPixels / 2) / devicePixelRatio;

    // draw gain nubbin
    ctx.fillStyle = `rgba(${rgb}, ${alpha / 4})`;
    ctx.beginPath();
    ctx.arc(centerX, centerY, layer.gain * unitGainNubbinRadius, 0, 2 * Math.PI);
    ctx.fill();

    top = maxY + layerHeightInPixels * 1.15;
  }

  // draw playhead
  const playheadX = GAIN_NUBBIN_SPACING + state.playhead * pixelsPerFrame;
  ctx.strokeStyle = '#999';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(playheadX, 0);
  ctx.lineTo(playheadX, top);
  ctx.stroke();
}

function displayRecordingHelp() {
  clearLogs();
  if (recording) {
    log({ color: '#888', text: '■' }, ' space');
  } else {
    log({ color: 'red', text: '●' }, ' space');
  }
}

// --- statuses ---

let status = '';
let statusColor = 'cornflowerblue';
let statusClearTimeMillis = 0;

function displayStatus(newStatus: string, color = 'cornflowerblue', timeMillis = 3_000) {
  status = newStatus;
  statusColor = color;
  statusClearTimeMillis = Date.now() + timeMillis;
  setTimeout(() => {
    if (Date.now() >= statusClearTimeMillis) {
      status = '';
    }
  }, timeMillis);
}

function renderStatus() {
  ctx.font = '20px Monaco';
  ctx.fillStyle = statusColor;
  const statusWidth = ctx.measureText(status).width;
  ctx.fillText(
    status,
    ctx.canvas.width / devicePixelRatio - 40 - statusWidth,
    (ctx.canvas.height - 40) / devicePixelRatio,
  );
}

// --- logs ---

type LoggedLinePart = { color: string; text: string } | string;
type LoggedLine = LoggedLinePart[];
const logs: LoggedLine[] = [];

function log(...line: LoggedLinePart[]) {
  logs.push(line);
}

function clearLogs() {
  logs.length = 0;
}

function renderLogs() {
  ctx.font = '20px Monaco';
  let y = (ctx.canvas.height - 40) / devicePixelRatio;
  const x0 = 40;
  for (const line of logs) {
    let x = x0;
    for (const part of line) {
      const text = typeof part === 'string' ? part : part.text;
      ctx.fillStyle = typeof part === 'string' ? 'black' : part.color;
      ctx.fillText(text, x, y);
      x += ctx.measureText(text).width;
    }
    y -= 25;
  }
}
