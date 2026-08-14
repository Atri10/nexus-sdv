import { beforeEach, describe, expect, it, jest } from 'bun:test';
import { act, renderHook } from '@testing-library/react';
import { usePmMessages } from '@/hooks/usePmMessages';
import type { PmMessage } from '@/lib/pm-types';

const STORAGE_KEY = 'pmMessages';

const mockClose = jest.fn();

class MockEventSource {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  close = mockClose;
  static instances: MockEventSource[] = [];
  constructor(public url: string) {
    MockEventSource.instances.push(this);
  }
}

beforeEach(() => {
  MockEventSource.instances = [];
  mockClose.mockReset();
  (global as unknown as { EventSource: unknown }).EventSource = MockEventSource;
  window.sessionStorage.clear();
});

const makeMessage = (vin: string): PmMessage => ({
  vin,
  component: 'battery',
  health_score: 80,
  severity: 'advisory',
  evidence: { temperature: '90' },
  explanation: `explanation ${vin}`,
  timestamp: '2026-08-10T00:00:00Z',
});

describe('usePmMessages sessionStorage hydration', () => {
  it('hydrates PmMessage objects stored by the message effect (regression)', () => {
    // The onmessage effect stores JSON.stringify of parsed PmMessage OBJECTS,
    // not raw strings. These must survive a reload.
    window.sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([makeMessage('VIN1'), makeMessage('VIN2')]),
    );
    const { result } = renderHook(() => usePmMessages());
    expect(result.current.messages).toHaveLength(2);
    expect(result.current.messages[0].vin).toBe('VIN1');
    expect(result.current.messages[1].vin).toBe('VIN2');
  });

  it('still hydrates legacy string entries', () => {
    window.sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([JSON.stringify(makeMessage('VIN3'))]),
    );
    const { result } = renderHook(() => usePmMessages());
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].vin).toBe('VIN3');
  });

  it('skips corrupted entries instead of dropping the whole list', () => {
    window.sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(['not-json', makeMessage('VIN4')]),
    );
    const { result } = renderHook(() => usePmMessages());
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].vin).toBe('VIN4');
  });

  it('starts empty when storage is empty', () => {
    const { result } = renderHook(() => usePmMessages());
    expect(result.current.messages).toEqual([]);
  });
});

describe('usePmMessages clearAlerts', () => {
  it('clears in-memory messages and sessionStorage', () => {
    window.sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([makeMessage('VIN1'), makeMessage('VIN2')]),
    );
    const { result } = renderHook(() => usePmMessages());
    expect(result.current.messages).toHaveLength(2);
    act(() => result.current.clearAlerts());
    expect(result.current.messages).toEqual([]);
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('is safe on an already-empty list', () => {
    const { result } = renderHook(() => usePmMessages());
    expect(() => act(() => result.current.clearAlerts())).not.toThrow();
    expect(result.current.messages).toEqual([]);
  });
});
