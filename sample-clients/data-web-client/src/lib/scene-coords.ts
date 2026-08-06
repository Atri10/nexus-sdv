export interface ScenePoint {
  x: number;
  z: number;
}

/** Project (lat, lng) to scene x/z. Meters-per-unit ~ 1 unit = 10m. */
export function projectLatLng(
  lat: number,
  lng: number,
  originLat: number,
  originLng: number,
  metersPerUnit = 10,
): ScenePoint {
  const R = 6371000;
  const dLat = (lat - originLat) * (Math.PI / 180);
  const dLng = (lng - originLng) * (Math.PI / 180);
  const x = (dLng * R * Math.cos((originLat * Math.PI) / 180)) / metersPerUnit;
  const z = -(dLat * R) / metersPerUnit; // north = -z (screen up)
  return { x, z };
}

/** True only when a WebGL2/WebGL context can be created. */
export function webglSupported(): boolean {
  if (typeof document === 'undefined') return false;
  try {
    const canvas = document.createElement('canvas');
    return !!(canvas.getContext('webgl2') || canvas.getContext('webgl'));
  } catch {
    return false;
  }
}
