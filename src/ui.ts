import { UiState } from './types';

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

function render() {
  ctx.clearRect(0, 0, innerWidth, innerHeight);
  ctx.beginPath();
  ctx.strokeStyle = 'black';
  ctx.moveTo(0, 0);
  ctx.lineTo(innerWidth, innerHeight);
  ctx.stroke();
}
