import { NUM_FRAMES_PER_CHUNK } from './constants';
import { MessageFromWorklet, MessageToWorklet } from './types';

const MAX_FRAMES_PER_CHANNEL = 1_000_000 * NUM_FRAMES_PER_CHUNK;

class Layer {
  isRecording = false;
  numFramesRecorded = 0;

  constructor(
    public frameOffset: number,
    public numChannels: number,
    public lengthInFrames: number | null,
    public samples: Float32Array = new Float32Array(MAX_FRAMES_PER_CHANNEL * 2),
  ) {}

  serialize() {
    return {
      frameOffset: this.frameOffset,
      numChannels: this.numChannels,
      lengthInFrames: this.lengthInFrames,
      numFramesRecorded: this.numFramesRecorded,
    };
  }

  /**
   * Mixes the frame from this layer that's under the `playhead` into `outputs`.
   *
   * @param output the output buffers (one per channel)
   * @param outputFrameIdx the frame of the output buffers that we'll mix into
   * @param playhead playhead position (frame index) of the looper
   */
  mixFrameInto(output: Float32Array[], outputFrameIdx: number, playhead: number) {
    if (this.lengthInFrames === null) {
      return;
    }

    const frameIdx = playhead % this.lengthInFrames!;
    for (let channel = 0; channel < output.length; channel++) {
      output[channel][outputFrameIdx] += this.getSampleAt(channel, frameIdx);
    }
  }

  /**
   * Returns this loop's contribution to `channel` for the specified frame.
   * @param frameIdx a value between 0 and lengthInFrames
   */
  getSampleAt(channel: number, frameIdx: number) {
    if (this.lengthInFrames === null) {
      throw new Error('called getSampleAt() on layer w/ lengthInFrames = null');
    }

    if (this.numChannels === 1) {
      // If this layer is mono, mix its samples into all channels.
      channel = 0;
    } else if (this.numChannels <= channel) {
      // This loop doesn't have a contribution for the specified channel.
      return 0;
    }

    let sample = 0;
    let sampleIdx = (frameIdx - this.frameOffset) * this.numChannels + channel;
    const numSamples = this.numFramesRecorded * this.numChannels; // TODO: revisit when we can load loops from the outside
    while (sampleIdx < numSamples) {
      if (sampleIdx >= 0) {
        sample += this.samples[sampleIdx];
      }
      sampleIdx += this.lengthInFrames * this.numChannels;
    }

    return sample;
  }

  recordFrame(input: Float32Array[], frameIdx: number) {
    if (!this.isRecording) {
      throw new Error("called recordFrame() on layer that isn't recording!");
    }

    if (input.length < this.numChannels) {
      throw new Error(
        `recording ${this.numChannels}-channel layer from ${input.length}-channel input`,
      );
    }

    let sampleIdx = this.numFramesRecorded++ * this.numChannels;
    for (let channel = 0; channel < this.numChannels; channel++) {
      this.samples[sampleIdx++] = input[channel][frameIdx];
    }
  }

  startRecording() {
    this.isRecording = true;
  }

  stopRecording() {
    if (!this.isRecording) {
      throw new Error("called stopRecording() on layer that isn't recording!");
    }

    this.isRecording = false;
    console.log('nfr', this.numFramesRecorded);
    if (this.lengthInFrames === null) {
      this.lengthInFrames = this.numFramesRecorded;
      console.log('lif', this.lengthInFrames);
    }
  }
}

class Looper extends AudioWorkletProcessor implements AudioWorkletProcessorImpl {
  layers: Layer[] = [];
  playhead: number | null = null;

  latencyOffsetInChunks = 0;

  constructor() {
    super();
    this.port.onmessage = (msg: MessageEvent<MessageToWorklet>) => this.onMessage(msg.data);
    this.say('hello from the worklet');
  }

  get lengthInFrames() {
    return this.layers.length > 0 ? this.layers[0].lengthInFrames : null;
  }

  sendMessage(msg: MessageFromWorklet, transferObjects: Transferable[] = []) {
    this.port.postMessage(msg, transferObjects);
  }

  say(msg: string) {
    this.sendMessage({ event: 'debug', payload: msg });
  }

  onMessage(msg: MessageToWorklet) {
    switch (msg.command) {
      case 'set latency offset': {
        console.log('set latency offset', msg.value);
        this.latencyOffsetInChunks = msg.value;
        break;
      }
      case 'start recording': {
        console.log('start recording!');
        const newLayer = new Layer(this.playhead ?? 0, 1, this.lengthInFrames);
        newLayer.startRecording();
        this.layers.push(newLayer);
        this.say('started recording');
        break;
      }
      case 'stop recording':
        console.log('stop recording');
        for (const l of this.layers) {
          if (l.isRecording) {
            l.stopRecording();
          }
        }
        if (this.layers.length === 1) {
          this.playhead = this.latencyOffsetInChunks * NUM_FRAMES_PER_CHUNK;
          this.say(`set playhead to ${this.playhead}`);
        }

        this.say('stopped recording');
        this.sendMessage({ event: 'debug', payload: this.layers.map((l) => l.serialize()) });
        break;
      default:
        console.log('unsupported message', msg);
        throw new Error('unsupported message!');
    }
  }

  first = true;
  process([input]: Float32Array[][], [output]: Float32Array[][], _parameters: any) {
    // if (this.first) {
    //   this.say(`${inputs.length} inputs, 1st has ${inputs[0].length} channels`);
    //   this.first = false;
    // }

    const numFrames = output[0].length;
    for (let frameIdx = 0; frameIdx < numFrames; frameIdx++) {
      for (const l of this.layers) {
        if (this.playhead !== null) {
          l.mixFrameInto(output, frameIdx, this.playhead);
        }
        if (l.isRecording) {
          l.recordFrame(input, frameIdx);
        }
      }
      if (this.playhead !== null) {
        this.advancePlayhead();
      }
    }
    return true;
  }

  advancePlayhead() {
    if (this.playhead === null) {
      throw new Error('called advancePlayhead() w/ null playhead');
    } else if (this.lengthInFrames === null) {
      return;
    }

    this.movePlayhead((this.playhead + 1) % this.lengthInFrames);
  }

  lastTimePlayheadMovedSent = 0;
  movePlayhead(newValue: number | null) {
    this.playhead = newValue;

    const now = Date.now();
    if (this.playhead === 0 || now - this.lastTimePlayheadMovedSent > 16) {
      this.sendMessage({ event: 'playhead moved', value: this.playhead });
      this.lastTimePlayheadMovedSent = now;
    }
  }
}

registerProcessor('looper', Looper);
