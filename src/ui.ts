import { NUM_FRAMES_PER_CHUNK } from './constants';
import { getLengthInFrames } from './helpers';
import { loadPersistentState, changePersistentState } from './persistence';
import {
  InputDeviceInfo,
  Layer,
  LooperState,
  MessageFromWorklet,
  MessageToWorklet,
  Position,
  UiState,
} from './types';

let looper: AudioWorkletNode;
let inputDeviceInfo: InputDeviceInfo;
let state: UiState;
let changeSharedState: (fn: (state: LooperState) => void) => void;
let channelToRecord = 0;
let midi: MIDIAccess | null = null;

export async function init(
  _looper: AudioWorkletNode,
  _inputDeviceInfo: InputDeviceInfo,
  _state: UiState,
  _changeSharedState: (fn: (state: LooperState) => void) => void,
) {
  looper = _looper;
  (window as any).looper = looper;
  inputDeviceInfo = _inputDeviceInfo;
  state = _state;
  changeSharedState = _changeSharedState;

  looper.port.onmessage = (msg) => onMessage(msg.data);

  const latencyOffset = loadPersistentState().deviceSpecificLatencyOffset[inputDeviceInfo.id] ?? 20;
  sendToWorklet({ command: 'set latency offset', value: latencyOffset });

  setChannelToRecord(loadPersistentState().channelToRecord[inputDeviceInfo.id] ?? 0);

  // keyboard
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  // mouse
  window.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);

  if (inputDeviceInfo.useMidiPedal) {
    try {
      midi = await navigator.requestMIDIAccess();
      midi.inputs.forEach((input) => {
        input.onmidimessage = (e) => {
          if (!e.data) {
            // no op
          } else if (
            e.data[0] >> 4 === 0xb && // CC
            e.data[1] === 64 && // sustain
            e.data[2] >= 64 // on
          ) {
            toggleRecording();
          }
        };
      });
      console.log('midi', midi);
    } catch {
      console.log('no midi :(');
    }
  }

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
        state.deviceSpecificLatencyOffset[inputDeviceInfo.id] = m.value;
      });
      break;
    default:
      console.info('worklet:', m);
  }
}

function setChannelToRecord(channel: number) {
  channelToRecord = channel;
  changePersistentState((state) => {
    state.channelToRecord[inputDeviceInfo.id] = channel;
  });
  sendToWorklet({ command: 'set channel to record', channel });
  displayRecordingHelp();
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
    case 's':
      toggleSoloed();
      break;
    case 'm':
      toggleMuted();
      break;
    case 'b':
      toggleBackwards();
      break;
    case 'Shift':
      onShift('down');
      break;
    case 'Control':
      onControl('down');
      break;
    case 'ArrowUp':
    case 'ArrowDown':
      changeLatencyOffsetBy(e.key === 'ArrowUp' ? 1 : -1);
      break;
    case 'ArrowLeft':
    case 'ArrowRight':
      channelToRecord = Math.max(
        0,
        Math.min(
          channelToRecord + (e.key === 'ArrowLeft' ? -1 : 1),
          inputDeviceInfo.numChannels - 1,
        ),
      );
      setChannelToRecord(channelToRecord);
      break;
    case 'h':
      toggleFullHelp();
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

function toggleSoloed() {
  changeLayer(getLayerAtPointer(), (layer) => {
    layer.soloed = !layer.soloed;
  });
}

function toggleMuted() {
  changeLayer(getLayerAtPointer(), (layer) => {
    layer.muted = !layer.muted;
  });
}

function toggleBackwards() {
  changeLayer(getLayerAtPointer(), (layer) => {
    layer.backwards = !layer.backwards;
  });
}

let gainChangeLayerInfo: { id: number; origGain: number; origPos: Position } | null = null;
let changingMasterGain = false;

function onControl(control: 'down' | 'up') {
  if (control === 'up') {
    changingMasterGain = false;
    gainChangeLayerInfo = null;
    return;
  }

  if (pointerPos.x >= innerWidth - MASTER_GAIN_SLIDER_WIDTH) {
    changingMasterGain = true;
    setMasterGain();
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
let movingPlayhead = false;

function onPointerDown(e: PointerEvent) {
  // hack so that I can test it on my iPad
  if (e.y >= innerHeight - BOTTOM_MARGIN_FOR_TEXT) {
    toggleRecording();
    return;
  }

  if (lengthInFrames !== null) {
    movingPlayhead = true;
    movePlayhead();
  }
}

function onPointerUp(e: PointerEvent) {
  movingPlayhead = false;
}

function onPointerMove(e: PointerEvent) {
  pointerPos.x = e.x;
  pointerPos.y = e.y;

  if (movingPlayhead) {
    movePlayhead();
  }

  if (changingMasterGain) {
    setMasterGain();
  }

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
      layer.frameOffset = Math.round(origOffset + change / pixelsPerFrame);
    });
  }
}

function movePlayhead() {
  const frameIdx = Math.max(
    0,
    Math.min(
      Math.round((pointerPos.x - GAIN_NUBBIN_SPACING) / pixelsPerFrame),
      lengthInFrames! - 1,
    ),
  );
  sendToWorklet({ command: 'move playhead', value: frameIdx });
}

function setMasterGain() {
  state.masterGain = (innerHeight - pointerPos.y) / innerHeight;
  sendToWorklet({ command: 'set master gain', value: state.masterGain });
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
const MASTER_GAIN_SLIDER_WIDTH = 10;

let lengthInFrames: number | null = null;
let pixelsPerFrame = 1;
let layerHeightInPixels = 32;
let unitGainNubbinRadius = layerHeightInPixels / 2;

function render() {
  ctx.clearRect(0, 0, innerWidth, innerHeight);
  // TODO: calculate this based on the layers: how many are there? how tall is each?
  layerHeightInPixels = LAYER_HEIGHT_IN_PIXELS;
  unitGainNubbinRadius = Math.ceil(layerHeightInPixels / 2);
  lengthInFrames = getLengthInFrames(state.shared.layers);
  if (lengthInFrames !== null) {
    pixelsPerFrame = (innerWidth - 2 * GAIN_NUBBIN_SPACING) / lengthInFrames;
  }
  renderLayers();
  renderMasterGainSlider();
  renderLogs();
  renderStatus();
}

function renderLayers() {
  if (lengthInFrames === null) {
    return;
  }

  let top = LAYER_HEIGHT_IN_PIXELS;
  const x0 = GAIN_NUBBIN_SPACING;
  const x1 = x0 + lengthInFrames * pixelsPerFrame;
  for (const layer of state.shared.layers) {
    const addlInfo = getAddlInfo(layer);
    const alpha = layer.muted ? 0.25 : 1;

    // draw samples
    const rgb = layer.soloed ? `50, 75, 117` : `100, 149, 237`;
    const sampleColor = `rgba(${rgb}, ${alpha})`;
    ctx.strokeStyle = sampleColor;
    ctx.lineWidth = NUM_FRAMES_PER_CHUNK * pixelsPerFrame;
    let y = top;
    let x = x0 + ((layer.frameOffset + lengthInFrames) % lengthInFrames) * pixelsPerFrame;
    for (let chunkIdx = 0; chunkIdx < addlInfo.maxAmplitudesInChunks.length; chunkIdx++) {
      if (x >= x1) {
        x = x0;
        y += layerHeightInPixels;
      }
      const amplitude =
        (((addlInfo.maxAmplitudesInChunks[
          layer.backwards ? addlInfo.maxAmplitudesInChunks.length - chunkIdx - 1 : chunkIdx
        ] /
          addlInfo.maxAmplitudeInLayer) *
          layerHeightInPixels) /
          2) *
        layer.gain;
      ctx.beginPath();
      ctx.moveTo(x, y - amplitude / 2);
      ctx.lineTo(x, y + amplitude / 2);
      ctx.stroke();
      x += NUM_FRAMES_PER_CHUNK * pixelsPerFrame;
    }

    const centerX = GAIN_NUBBIN_SPACING / 2;
    const centerY = (top + y) / 2;

    addlInfo.gainNubbinCenterPosition = { x: centerX, y: centerY };
    addlInfo.topY = top - layerHeightInPixels / 2;
    addlInfo.bottomY = y + layerHeightInPixels / 2;

    // draw gain nubbin
    ctx.fillStyle = `rgba(${rgb}, ${alpha / 4})`;
    ctx.beginPath();
    ctx.arc(centerX, centerY, layer.gain * unitGainNubbinRadius, 0, 2 * Math.PI);
    ctx.fill();

    top = y + layerHeightInPixels * 1.15;
  }

  // draw playhead
  const playheadX = GAIN_NUBBIN_SPACING + state.playhead * pixelsPerFrame;
  ctx.strokeStyle = '#999';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(playheadX, layerHeightInPixels);
  ctx.lineTo(playheadX, top);
  ctx.stroke();
}

function displayRecordingHelp() {
  clearLogs();
  if (recording) {
    log({ color: 'cornflowerblue', text: 'SPACE' }, ' to ', { color: '#888', text: '■' });
  } else {
    log(
      { color: 'cornflowerblue', text: 'SPACE' },
      ' to ',
      { color: 'red', text: '●' },
      ` channel ${channelToRecord}`,
    );
  }

  log({ color: 'cornflowerblue', text: 'H' }, ' for help');
}

function renderMasterGainSlider() {
  const height = state.masterGain * innerHeight;
  ctx.fillStyle = 'rgba(100, 149, 237, .25)';
  ctx.fillRect(
    innerWidth - MASTER_GAIN_SLIDER_WIDTH,
    innerHeight - height,
    MASTER_GAIN_SLIDER_WIDTH,
    height,
  );
  ctx.fill();
}

// --- statuses ---

let status = '';
let statusColor = 'cornflowerblue';
let statusClearTimeMillis = 0;

const LEFT_MARGIN_FOR_TEXT = 40;
const BOTTOM_MARGIN_FOR_TEXT = 40;

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
    innerWidth - LEFT_MARGIN_FOR_TEXT - statusWidth,
    innerHeight - BOTTOM_MARGIN_FOR_TEXT,
  );
}

// --- logs ---

type LoggedLinePart = { color: string; text: string } | string;
type LoggedLine = LoggedLinePart[];
const logs: LoggedLine[] = [];

function log(...line: LoggedLinePart[]) {
  logs.unshift(line);
}

function clearLogs() {
  logs.length = 0;
}

function renderLogs() {
  ctx.font = '20px Monaco';
  let y = innerHeight - BOTTOM_MARGIN_FOR_TEXT;
  const x0 = LEFT_MARGIN_FOR_TEXT;
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

// --- help ---

let displayingFullHelp = false;

function toggleFullHelp() {
  if (displayingFullHelp) {
    displayRecordingHelp();
  } else {
    displayFullHelp();
  }
  displayingFullHelp = !displayingFullHelp;
}

function displayFullHelp() {
  clearLogs();
  log('To start recording a new layer, press ', b('SPACE'), '.');
  log('To stop recording, press ', b('SPACE'), ' again.');
  log('');
  log('If you point at a layer,');
  log('- hold down ', b('SHIFT'), ' and move mouse left/right to slide layer in time');
  log(
    '- hold down ',
    b('CONTROL'),
    " and move mouse up/down to change the layer's gain (louder/softer)",
  );
  log('- press ', b('BACKSPACE'), ' to delete the layer');
  log('- press ', b('M'), ' to toggle mute');
  log('- press ', b('S'), ' to toggle solo');
  log('- press ', b('B'), ' to toggle backwards');
  log('- press ', b('D'), ' to duplicate the layer');
  log('');
  log('The blue bar at the right margin is the master volume slider.');
  log('Point at it, hold down ', b('CONTROL'), ' and move mouse up/down to adjust it.');
  log();
  log('Press ', b('LEFT'), '/', b('RIGHT'), " to change the channel you're recording from.");
  log();
  log('Press ', b('UP'), '/', b('DOWN'), ' to adjust the latency offset.');
  log('(The right setting depends on your input device and computer -- see what works best!)');
  log();
  log('Press ', b('H'), ' to make this help go away.');

  function b(text: string) {
    return { color: 'cornflowerblue', text };
  }
}
