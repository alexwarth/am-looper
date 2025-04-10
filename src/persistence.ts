export interface PersistentState {
  lastUsedDeviceId: string | null;
  deviceSpecificLatencyOffset: { [deviceId: string]: number };
}

export function loadPersistentState() {
  let serializedPs = localStorage.getItem('ui-state');
  return serializedPs !== null
    ? JSON.parse(serializedPs)
    : { lastUsedDeviceId: null, deviceSpecificLatencyOffset: {} };
}

export function savePersistentState(ps: PersistentState) {
  localStorage.setItem('ui-state', JSON.stringify(ps));
}

export function changePersistentState(fn: (ps: PersistentState) => void) {
  const ps = loadPersistentState();
  fn(ps);
  savePersistentState(ps);
}
