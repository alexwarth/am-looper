export interface UiState {
  shared: LooperState;
  samplesAsFloats: Map<number, Float32Array>;
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
  | { command: 'start recording' }
  | { command: 'stop recording' }
  | { command: 'update layers'; loops: LayerNoSamples[] }
  | { command: 'set layer samples'; layerId: number; samples: Float32Array };

export type MessageFromWorklet =
  | { event: 'started recording'; frameOffset: number }
  | { event: 'finished recording'; layer: LayerNoSamples; samples: ArrayBuffer }
  | { event: 'playhead moved'; value: number }
  | { event: 'debug'; payload: any };
