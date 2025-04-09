export interface LooperState {
  layers: Layer[];
}

export interface Layer extends LayerNoSamples {
  // this is actually a bunch of 32-bit floating point numbers, channels are interleaved
  // to convert to array of 32-bit floats: `Float32Array.from(myLoop.samples)`
  samples: Uint8Array;
}

export interface LayerNoSamples {
  lengthInFrames: number;
  frameOffset: number;
  numChannels: number;
  numSamplesRecorded: number;
}

export interface AddlLayerInfo {
  maxChunkAmplitudes: number[]; // one per channel
}

export type MessageToWorklet =
  | { command: 'set latency offset'; value: number }
  | { command: 'start recording' }
  | { command: 'stop recording' }
  | { command: 'cancel recording' }
  | { command: 'start playing' }
  | { command: 'stop playing' }
  | { command: 'update loops'; loops: LayerNoSamples[] }
  | { command: 'set layer samples'; loopId: number; samples: Float32Array };

export type MessageFromWorklet =
  | { event: 'started recording'; frameOffset: number }
  | { event: 'recorded more samples'; samples: Float32Array }
  | { event: 'finished recording'; loop: LayerNoSamples }
  | { event: 'playhead moved'; value: number | null }
  | { event: 'debug'; payload: any };
