/**
 * Demo VIN pool — shared between the client UI (demo control bar, fleet
 * pickers) and server route handlers (demo/vehicle validation). Kept in a
 * plain module (no 'use client', no component imports) so both sides can
 * import it without dragging a client component into the server bundle.
 */
export const VIN_POOL: string[] = Array.from({ length: 10 }, (_, i) => `VIN${1001 + i}`);
