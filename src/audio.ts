import { SAMPLE_RATE } from './constants';

export async function init(context: AudioContext, looper: AudioWorkletNode) {
  const deviceId = await selectDevice();
  const micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId,
      autoGainControl: false,
      echoCancellation: false,
    },
  });
  const mic = context.createMediaStreamSource(micStream);
  mic.connect(looper).connect(context.destination);
  context.resume();
  looper.connect(context.destination);

  const totalLatencySecs = context.baseLatency + context.outputLatency;
  const totalLatencyFrames = totalLatencySecs * SAMPLE_RATE;
  const totalLatencyChunks = Math.ceil(totalLatencyFrames / 128);
  console.log('totalLatencySecs', totalLatencySecs);
  console.log('totalLatencyFrames', totalLatencyFrames);
  console.log('totalLatencyChunks', totalLatencyChunks);
  looper.port.postMessage({ command: 'set latency offset', value: totalLatencyChunks });
}

async function selectDevice() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return new Promise<string>((resolve) => {
    const buttons = document.getElementById('buttons') as HTMLDivElement;
    buttons.appendChild(div(document.createTextNode('Select input device:')));

    for (const d of devices) {
      if (d.kind !== 'audioinput') {
        continue;
      }

      const button = document.createElement('button');
      button.textContent = d.label;
      button.onclick = (e) => {
        buttons.textContent = '';
        resolve(d.deviceId);
      };
      buttons.appendChild(button);
    }
  });
}

function div(...children: any) {
  const el = document.createElement('div');
  for (const child of children) {
    el.appendChild(child);
  }
  return el;
}
