// TODO: clean up the mess that I made w/ devicePixelRatio
// (I want pointer coordinates to match up with screen coordinates)

import { NUM_FRAMES_PER_CHUNK } from './constants';
import { distance, getLengthInFrames } from './helpers';
import { Layer, LooperState, MessageFromWorklet, Position, UiState } from './types';

let looper: AudioWorkletNode;
let state: UiState;
let changeSharedState: (fn: (state: LooperState) => void) => void;

export function init(
  _looper: AudioWorkletNode,
  _state: UiState,
  _changeSharedState: (fn: (state: LooperState) => void) => void,
) {
  looper = _looper;
  state = _state;
  changeSharedState = _changeSharedState;
  displayRecordingHelp();

  looper.port.onmessage = (msg) => onMessage(msg.data);

  function onFrame() {
    render();
    requestAnimationFrame(onFrame);
  }
  onFrame();

  // keyboard
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keydown', onKeyUp);

  // mouse
  window.addEventListener('pointerdown', (e) =>
    onPointerDown(e.x / devicePixelRatio, e.y / devicePixelRatio, e),
  );
  window.addEventListener('pointermove', (e) =>
    onPointerMove(e.x / devicePixelRatio, e.y / devicePixelRatio),
  );
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
      state.samplesAsFloats.set(m.layer.id, new Float32Array(m.samples));
      break;
    case 'changed latency offset':
      console.log('new latency offset', m.value);
      displayStatus(`latency offset = ${m.value}`);
      break;
    default:
      console.info('worklet:', m);
  }
}

function changeLayer(id: number, fn: (layer: Layer) => void) {
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
        onSpace();
      }
      break;
    case 'Shift':
      onShift('down');
      break;
    case 'ArrowUp':
      changeLatencyOffsetBy(1);
      break;
    case 'ArrowDown':
      changeLatencyOffsetBy(-1);
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
  }
}

let recording = false;

function onSpace() {
  if (recording) {
    looper.port.postMessage({ command: 'stop recording' });
    recording = false;
    displayStatus('■', '#888');
  } else {
    looper.port.postMessage({ command: 'start recording' });
    recording = true;
    displayStatus('●', 'red');
  }
  displayRecordingHelp();
}

let gainChangeLayerInfo: { id: number; origGain: number; origPos: Position } | null = null;

function onShift(shift: 'down' | 'up') {
  if (shift === 'up') {
    gainChangeLayerInfo = null;
    return;
  }

  const id = getLayerAtPointer();
  if (id === null) {
    gainChangeLayerInfo = null;
    return;
  }

  const layer = state.shared.layers.find((layer) => layer.id === id)!;
  gainChangeLayerInfo = { id, origGain: layer?.gain, origPos: { ...pointerPos } };
}

function changeLatencyOffsetBy(increment: number) {
  looper.port.postMessage({ command: 'change latency offset', by: increment });
}

// --- mouse controls ---

const pointerPos = { x: 0, y: 0 };

function onPointerDown(x: number, y: number, e: PointerEvent) {
  const id = getLayerAtPointer();
  if (id) {
    changeSharedState((state) => {
      const idx = state.layers.findIndex((l) => l.id === id);
      if (idx < 0) {
        // ignore
      } else if (e.metaKey) {
        if (idx >= 0) {
          state.layers.splice(idx, 1);
        }
      } else {
        const l = state.layers[idx];
        l.muted = !l.muted;
      }
    });
  }
}

function onPointerMove(x: number, y: number) {
  pointerPos.x = x;
  pointerPos.y = y;
  if (gainChangeLayerInfo === null) {
    return;
  }

  const { id, origPos, origGain } = gainChangeLayerInfo;
  changeLayer(id, (layer) => {
    const change = -(pointerPos.y - origPos.y);
    layer.gain = Math.max(0, Math.min(origGain + change / MAX_GAIN_NUBBIN_RADIUS, 1));
  });
}

function getLayerAtPointer() {
  let id: number | null = null;
  let minDist = Infinity;
  for (const l of state.shared.layers) {
    const dist = distance(pointerPos, getAddlInfo(l).gainNubbinCenterPosition);
    if (dist <= MAX_GAIN_NUBBIN_RADIUS / devicePixelRatio && dist < minDist) {
      id = l.id;
      minDist = dist;
    }
  }
  return id;
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

function render() {
  ctx.clearRect(0, 0, innerWidth, innerHeight);
  renderLayers();
  renderLogs();
  renderStatus();
}

const LAYER_HEIGHT_IN_PIXELS = 32;
const MAX_GAIN_NUBBIN_RADIUS = LAYER_HEIGHT_IN_PIXELS / 2;
const GAIN_NUBBIN_SPACING = 100;

function renderLayers() {
  const layers = state.shared.layers;
  const lengthInFrames = getLengthInFrames(layers);
  if (lengthInFrames === null) {
    return;
  }

  const pixelsPerFrame = (innerWidth - 2 * GAIN_NUBBIN_SPACING) / lengthInFrames;
  let top = 2 * LAYER_HEIGHT_IN_PIXELS;
  const x0 = GAIN_NUBBIN_SPACING;
  const x1 = x0 + lengthInFrames * pixelsPerFrame;
  for (let idx = 0; idx < layers.length; idx++) {
    const layer = layers[idx];
    const addlInfo = getAddlInfo(layer);
    const alpha = layer.muted ? 0.25 : 1;
    let maxY = top;
    for (let rep = 0; rep < layer.numFramesRecorded / lengthInFrames; rep++) {
      let y = top;

      // draw samples
      let x = x0 + ((layer.frameOffset + lengthInFrames) % lengthInFrames) * pixelsPerFrame;
      for (let chunkIdx = 0; chunkIdx < addlInfo.maxAmplitudesInChunks.length; chunkIdx++) {
        if (x >= x1) {
          x = x0;
          y += LAYER_HEIGHT_IN_PIXELS;
        }

        ctx.lineWidth = NUM_FRAMES_PER_CHUNK * pixelsPerFrame;
        ctx.strokeStyle = `rgba(100, 149, 237, ${alpha})`;
        ctx.beginPath();
        const amplitude =
          ((addlInfo.maxAmplitudesInChunks[chunkIdx] / addlInfo.maxAmplitudeInLayer) *
            LAYER_HEIGHT_IN_PIXELS) /
          2;
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
    addlInfo.topY = top / devicePixelRatio;
    addlInfo.bottomY = maxY / devicePixelRatio;

    // draw gain nubbin
    ctx.fillStyle = `rgba(100, 149, 237, ${alpha / 4})`;
    ctx.beginPath();
    ctx.arc(centerX, centerY, layer.gain * MAX_GAIN_NUBBIN_RADIUS, 0, 2 * Math.PI);
    ctx.fill();

    top = maxY + LAYER_HEIGHT_IN_PIXELS * 1.15;
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
    (ctx.canvas.width - 50) / devicePixelRatio - statusWidth,
    (ctx.canvas.height - 80) / devicePixelRatio,
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
