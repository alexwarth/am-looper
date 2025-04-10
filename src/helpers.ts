import { Layer, LayerNoSamples, Position } from './types';

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

export function copyWithoutSamples(layer: Layer): LayerNoSamples {
  const r = { ...layer };
  delete (r as any).samples;
  return r;
}

export function distance(p1: Position, p2: Position) {
  return Math.sqrt((p2.x - p1.x) ** 2 + (p2.y - p1.y) ** 2);
}
