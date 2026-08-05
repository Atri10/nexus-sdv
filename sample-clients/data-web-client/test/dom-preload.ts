// Registers happy-dom globals so @testing-library/react works under `bun test`.
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { expect, mock } from 'bun:test';
import React from 'react';

GlobalRegistrator.register();

// next/image enforces width/height at runtime and happy-dom has no layout
// engine, so render a plain <img> instead (mirrors the stub next/jest used).
mock.module('next/image', () => ({
  default: (props: Record<string, unknown>) => React.createElement('img', props),
}));

// jest-dom matchers used by the component tests. They were previously provided
// by @testing-library/jest-dom via jest.setup.ts (deleted with the jest infra);
// these minimal reimplementations keep the assertions intact under bun.
function isElement(v: unknown): v is Element {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { nodeType?: unknown }).nodeType === 'number'
  );
}

expect.extend({
  toBeInTheDocument(received: unknown) {
    const pass = isElement(received) && received.isConnected;
    return {
      pass,
      message: () => `expected element ${pass ? 'not ' : ''}to be in the document`,
    };
  },
  toBeEmptyDOMElement(received: unknown) {
    const pass = isElement(received) && received.childNodes.length === 0;
    return {
      pass,
      message: () => `expected element ${pass ? 'not ' : ''}to be empty`,
    };
  },
  toHaveClass(received: unknown, expected: string) {
    const pass = isElement(received) && received.classList.contains(expected);
    return {
      pass,
      message: () => `expected element ${pass ? 'not ' : ''}to have class "${expected}"`,
    };
  },
  toHaveAttribute(received: unknown, name: string, value?: string) {
    const el = isElement(received) ? received : null;
    const actual = el?.getAttribute(name) ?? null;
    const pass = el !== null && (value === undefined ? actual !== null : actual === value);
    return {
      pass,
      message: () =>
        `expected element ${pass ? 'not ' : ''}to have attribute "${name}"` +
        (value !== undefined ? `="${value}"` : '') +
        (el ? ` (actual: ${actual})` : ''),
    };
  },
  toHaveStyle(received: unknown, expected: Record<string, string>) {
    const el = isElement(received) ? (received as HTMLElement) : null;
    const pass =
      el !== null &&
      Object.entries(expected).every(
        ([prop, value]) => (el.style as unknown as Record<string, string>)[prop] === value,
      );
    return {
      pass,
      message: () => `expected element ${pass ? 'not ' : ''}to have style ${JSON.stringify(expected)}`,
    };
  },
});
