export interface PersistentState {
  lastUsedDeviceId: string | null;
  deviceSpecificLatencyOffset: { [deviceId: string]: number };
  channelToRecord: { [deviceId: string]: number };
}

export function loadPersistentState(): PersistentState {
  let serializedPs = localStorage.getItem('ui-state');
  const ps = serializedPs !== null ? JSON.parse(serializedPs) : {};
  if (!('lastUsedDeviceId' in ps)) {
    ps.lastUsedDeviceId = null;
  }
  if (!('deviceSpecificLatencyOffset' in ps)) {
    ps.deviceSpecificLatencyOffset = {};
  }
  if (!('channelToRecord' in ps)) {
    ps.channelToRecord = {};
  }
  return ps;
}

export function savePersistentState(ps: PersistentState) {
  localStorage.setItem('ui-state', JSON.stringify(ps));
}

export function changePersistentState(fn: (ps: PersistentState) => void) {
  const ps = loadPersistentState();
  fn(ps);
  savePersistentState(ps);
}
