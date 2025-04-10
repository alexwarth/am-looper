import { NUM_FRAMES_PER_CHUNK } from './constants';
import { getLengthInFrames } from './helpers';
import { LayerNoSamples, MessageFromWorklet, MessageToWorklet } from './types';

const MAX_FRAMES_PER_CHANNEL = 1_000_000 * NUM_FRAMES_PER_CHUNK;

class Looper extends AudioWorkletProcessor implements AudioWorkletProcessorImpl {
  readonly samplesByLayerId = new Map<number, Float32Array>();
  layers: LayerNoSamples[] = [];
  recordingLayer: LayerNoSamples | null = null;
  playhead = 0;
  latencyOffsetInChunks = 0;

  constructor() {
    super();
    this.port.onmessage = (msg: MessageEvent<MessageToWorklet>) => this.onMessage(msg.data);
  }

  sendMessage(msg: MessageFromWorklet, transferObjects: Transferable[] = []) {
    this.port.postMessage(msg, transferObjects);
  }

  say(msg: string) {
    this.sendMessage({ event: 'debug', payload: msg });
  }

  onMessage(msg: MessageToWorklet) {
    switch (msg.command) {
      case 'set latency offset':
        this.setLatencyOffset(msg.value);
        break;
      case 'change latency offset':
        this.setLatencyOffset(this.latencyOffsetInChunks + msg.by);
        break;
      case 'start recording':
        this.startRecording();
        break;
      case 'stop recording':
        this.stopRecording();
        break;
      case 'update layers':
        this.updateLayers(msg.layers);
        break;
      case 'set layer samples':
        this.setLayerSamples(msg.id, new Float32Array(msg.samples));
        break;
      default:
        console.error('unsupported message', msg);
        throw new Error('unsupported message!');
    }
  }

  setLatencyOffset(newValue: number) {
    console.log('set latency offset', newValue);
    this.latencyOffsetInChunks = newValue;
    this.sendMessage({ event: 'changed latency offset', value: this.latencyOffsetInChunks });
  }

  startRecording() {
    if (this.recordingLayer) {
      return;
    }

    console.log('start recording!');
    this.recordingLayer = {
      id: Math.random(),
      lengthInFrames: getLengthInFrames(this.layers) ?? -1,
      frameOffset: this.playhead - this.latencyOffsetInChunks * NUM_FRAMES_PER_CHUNK,
      numChannels: 1,
      numFramesRecorded: 0,
      muted: false,
      gain: 1,
    };
    this.samplesByLayerId.set(this.recordingLayer.id, new Float32Array(MAX_FRAMES_PER_CHANNEL));
    this.say('started recording');
  }

  stopRecording() {
    if (!this.recordingLayer) {
      return;
    }

    console.log('stop recording');
    if (this.recordingLayer.lengthInFrames < 0) {
      // this is the first layer we've recorded, so it determines the length of the loop
      this.recordingLayer.lengthInFrames = this.recordingLayer.numFramesRecorded;
    }
    if (this.layers.length === 0) {
      this.movePlayhead(this.latencyOffsetInChunks * NUM_FRAMES_PER_CHUNK);
    }
    const samples = this.samplesByLayerId
      .get(this.recordingLayer.id)!
      .slice(0, this.recordingLayer.numFramesRecorded * this.recordingLayer.numChannels).buffer;
    this.sendMessage({ event: 'finished recording', layer: this.recordingLayer, samples }, [
      samples,
    ]);
    this.layers.push(this.recordingLayer);
    this.recordingLayer = null;
  }

  updateLayers(newLayers: LayerNoSamples[]) {
    console.log('update layers');
    this.layers = newLayers;
  }

  setLayerSamples(id: number, samples: Float32Array) {
    console.log('set layer samples');
    this.samplesByLayerId.set(id, samples);
  }

  process([input]: Float32Array[][], [output]: Float32Array[][], _parameters: any) {
    const numFrames = output[0].length;
    for (let frameIdx = 0; frameIdx < numFrames; frameIdx++) {
      if (this.recordingLayer) {
        this.mixFrameInto(this.recordingLayer, output, frameIdx);
        this.recordFrame(input, frameIdx);
      }
      for (const l of this.layers) {
        if (!l.muted) {
          this.mixFrameInto(l, output, frameIdx);
        }
      }
      this.advancePlayhead();
    }
    return true;
  }

  /**
   * Mixes the frame from this layer that's under the `playhead` into `outputs`.
   *
   * @param output the output buffers (one per channel)
   * @param outputFrameIdx the frame of the output buffers that we'll mix into
   * @param playhead playhead position (frame index) of the looper
   */
  mixFrameInto(layer: LayerNoSamples, output: Float32Array[], outputFrameIdx: number) {
    if (layer.lengthInFrames < 0) {
      return;
    }

    const frameIdx = this.playhead % layer.lengthInFrames;
    for (let channel = 0; channel < output.length; channel++) {
      output[channel][outputFrameIdx] += layer.gain * this.getSampleAt(layer, channel, frameIdx);
    }
  }

  /**
   * Returns the layer's contribution to `channel` for the specified frame.
   * @param frameIdx a value between 0 and lengthInFrames
   */
  getSampleAt(layer: LayerNoSamples, channel: number, frameIdx: number) {
    if (layer.numChannels === 1) {
      // If this layer is mono, mix its samples into all channels.
      channel = 0;
    } else if (layer.numChannels <= channel) {
      // This layer doesn't have a contribution for the specified channel.
      return 0;
    }

    let sample = 0;
    let sampleIdx = (frameIdx - layer.frameOffset) * layer.numChannels + channel;
    const numSamples = layer.numFramesRecorded * layer.numChannels;
    const samples = this.samplesByLayerId.get(layer.id);
    if (!samples) {
      // The samples for this layer haven't arrived yet (this will happen when we're running on automerge)
      return 0;
    }
    while (sampleIdx < numSamples) {
      if (sampleIdx >= 0) {
        sample += samples[sampleIdx];
      }
      sampleIdx += layer.lengthInFrames * layer.numChannels;
    }

    return sample;
  }

  recordFrame(input: Float32Array[], frameIdx: number) {
    if (!this.recordingLayer) {
      throw new Error('called recordFrame() when recordingLayer was null!');
    }

    if (input.length < this.recordingLayer.numChannels) {
      throw new Error(
        `recording ${this.recordingLayer.numChannels}-channel layer from ${input.length}-channel input`,
      );
    }

    let sampleIdx = this.recordingLayer.numFramesRecorded++ * this.recordingLayer.numChannels;
    const samples = this.samplesByLayerId.get(this.recordingLayer.id)!;
    for (let channel = 0; channel < this.recordingLayer.numChannels; channel++) {
      samples[sampleIdx++] = input[channel][frameIdx];
    }
  }

  advancePlayhead() {
    if (this.playhead === null) {
      throw new Error('called advancePlayhead() w/ null playhead');
    }

    const lengthInFrames = getLengthInFrames(this.layers);
    if (lengthInFrames !== null) {
      this.movePlayhead((this.playhead + 1) % lengthInFrames);
    }
  }

  lastTimePlayheadMovedSent = 0;
  movePlayhead(newValue: number) {
    this.playhead = newValue;

    const now = Date.now();
    if (this.playhead === 0 || now - this.lastTimePlayheadMovedSent > 16) {
      this.sendMessage({ event: 'playhead moved', value: this.playhead });
      this.lastTimePlayheadMovedSent = now;
    }
  }
}

registerProcessor('looper', Looper);
