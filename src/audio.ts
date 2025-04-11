import { InputDeviceInfo } from './types';

const options = { autoGainControl: false, echoCancellation: false };

export async function init(
  context: AudioContext,
  looper: AudioWorkletNode,
): Promise<InputDeviceInfo> {
  const deviceId = await selectDevice();
  console.log(options);
  const micStream = await navigator.mediaDevices.getUserMedia({
    audio: { deviceId, ...options },
  });
  const mic = context.createMediaStreamSource(micStream);

  // Super weird: I wasn't able to refresh the page and switch inputs successfully, but now I can.
  // What changed? Just the console.log() below. Now that it's there, I can switch inputs without
  // a hitch. TODO: figure out why!
  console.log('input stream', mic);

  mic.connect(looper).connect(context.destination);
  context.resume();
  looper.connect(context.destination);

  return { id: deviceId, numChannels: mic.channelCount };
}

async function selectDevice() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return new Promise<string>((resolve) => {
    const buttons = document.getElementById('buttons') as HTMLDivElement;
    buttons.appendChild(tag('div', document.createTextNode('Select input device:')));

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

    buttons.appendChild(tag('div', document.createTextNode('')));
    buttons.appendChild(tag('div', document.createTextNode('Options:')));
    buttons.appendChild(option('autoGainControl', 'auto gain control'));
    buttons.appendChild(option('echoCancellation', 'echo cancellation'));
  });
}

function tag(name: string, ...children: any) {
  const el = document.createElement(name);
  for (const child of children) {
    el.appendChild(child);
  }
  return el;
}

function option(name: string, label: string) {
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = options[name];
  checkbox.id = name;
  checkbox.onchange = () => {
    options[name] = checkbox.checked;
  };
  return tag('span', checkbox, document.createTextNode(' ' + label));
}

function getOptionValue(id: string, defaultValue = false): boolean {
  console.log(id, '=', document.getElementById(id));
  return (document.getElementById(id) as HTMLInputElement)?.checked ?? defaultValue;
}
