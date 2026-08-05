// @testing-library/react's auto-cleanup registers on an ambient `afterEach`
// global at import time, which bun does not inject by then — without this,
// rendered DOM leaks across test files that share a worker process.
//
// Loaded AFTER test/dom-preload.ts (which registers happy-dom globals), so
// @testing-library/dom can bind its queries to a real document.
import { afterEach } from 'bun:test';
import { cleanup } from '@testing-library/react';

afterEach(() => cleanup());
