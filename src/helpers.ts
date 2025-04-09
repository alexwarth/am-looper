import { LayerNoSamples } from './types';

export function getLengthInFrames(layers: LayerNoSamples[]) {
  if (layers.length === 0) {
    return null;
  }

  // In single-user mode, every layer will have the same lengthInFrames.
  // But if two or more clients both *think* that they're recording the first
  // layer, we'll end up with layers w/ different values for lengthInFrames.
  let length = layers[0].lengthInFrames;
  for (let layer of layers) {
    length = Math.max(length, layer.lengthInFrames);
  }
  return length;
}
