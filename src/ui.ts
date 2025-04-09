import { NUM_FRAMES_PER_CHUNK } from './constants';
import { getLengthInFrames } from './helpers';
import { Layer, UiState } from './types';

let looper: AudioWorkletNode;
let state: UiState;

export function init(_looper: AudioWorkletNode, _state: UiState) {
  looper = _looper;
  state = _state;

  function onFrame() {
    render();
    requestAnimationFrame(onFrame);
  }
  onFrame();
}

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;

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

window.addEventListener('keydown', (e) => {
  switch (e.key) {
    case ' ': {
      if (!spaceIsDown) {
        spaceIsDown = true;
        onSpace();
      }
      break;
    }
  }
});

window.addEventListener('keyup', (e) => {
  switch (e.key) {
    case ' ': {
      spaceIsDown = false;
      break;
    }
  }
});

let recording = false;

function onSpace() {
  if (recording) {
    looper.port.postMessage({ command: 'stop recording' });
    recording = false;
  } else {
    looper.port.postMessage({ command: 'start recording' });
    recording = true;
  }
}

interface AddlLayerInfo {
  maxAmplitudesInChunks: number[];
  maxAmplitudeInLayer: number;
  gainNubbinCenterPosition: { x: number; y: number };
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

function render() {
  ctx.clearRect(0, 0, innerWidth, innerHeight);
  renderLayers();
}

const LAYER_HEIGHT_IN_PIXELS = 32;
const MAX_GAIN_NUBBIN_RADIUS = LAYER_HEIGHT_IN_PIXELS / 2;
const GAIN_NUBBIN_SPACING = 100;

function renderLayers() {
  const lengthInFrames = getLengthInFrames(state.doc.layers);
  if (lengthInFrames === null) {
    return;
  }

  const pixelsPerFrame = (innerWidth - 2 * GAIN_NUBBIN_SPACING) / lengthInFrames;
  let top = 2 * LAYER_HEIGHT_IN_PIXELS;
  const layers = state.doc.layers;
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
