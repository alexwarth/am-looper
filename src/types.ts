export interface Position {
  x: number;
  y: number;
}

export interface UiState {
  shared: LooperState;
  playhead: number;
}

export interface LooperState {
  layers: Layer[];
}

export interface Layer extends LayerNoSamples {
  // this is actually a bunch of 32-bit floating point numbers, channels are interleaved
  // to convert to array of 32-bit floats: `Float32Array.from(myLoop.samples)`
  samples: Uint8Array;
}

export interface LayerNoSamples {
  id: number;
  lengthInFrames: number;
  frameOffset: number;
  numChannels: number;
  numFramesRecorded: number;
  muted: boolean;
  gain: number;
}

export type MessageToWorklet =
  | { command: 'set latency offset'; value: number }
  | { command: 'change latency offset'; by: number }
  | { command: 'start recording' }
  | { command: 'stop recording' }
  | { command: 'update layers'; layers: LayerNoSamples[] }
  | { command: 'set layer samples'; id: number; samples: Float32Array };

export type MessageFromWorklet =
  | { event: 'started recording'; frameOffset: number }
  | { event: 'finished recording'; layer: LayerNoSamples; samples: ArrayBuffer }
  | { event: 'playhead moved'; value: number }
  | { event: 'changed latency offset'; value: number }
  | { event: 'debug'; payload: any };
