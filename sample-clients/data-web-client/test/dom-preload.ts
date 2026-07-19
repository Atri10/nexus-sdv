// Minimal browser globals so client-only modules that pull in DOM-dependent
// libraries (e.g. chartjs-plugin-zoom -> hammerjs) can be imported under the
// node/bun test runtime, which has no `window`/`document` by default.
const g = globalThis as unknown as { window?: unknown; document?: unknown; navigator?: unknown };

if (typeof g.window === 'undefined') {
  g.window = g;
}
if (typeof g.document === 'undefined') {
  g.document = {
    createElement: () => ({ getContext: () => null, style: {} }),
    documentElement: { style: {} },
    addEventListener: () => {},
    removeEventListener: () => {},
    getElementsByTagName: () => [],
  };
}
if (typeof g.navigator === 'undefined') {
  g.navigator = { userAgent: 'bun-test' };
}
