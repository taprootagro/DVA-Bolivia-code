// ============================================================================
// Vitest Test Setup
// ============================================================================
// This file runs before every test suite. It configures:
//   1. jsdom DOM environment (browser-like APIs)
//   2. @testing-library/jest-dom matchers (toBeInTheDocument, etc.)
//   3. Global mocks for browser APIs not implemented in jsdom
// ============================================================================

import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';

// ── Mock matchMedia (not implemented in jsdom) ──
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

// ── Mock IntersectionObserver (not implemented in jsdom) ──
class MockIntersectionObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}
Object.defineProperty(window, 'IntersectionObserver', {
  writable: true,
  value: MockIntersectionObserver,
});

// ── Mock scrollTo (not implemented in jsdom) ──
window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;

// ── Mock requestAnimationFrame ──
window.requestAnimationFrame = vi.fn((cb: FrameRequestCallback) => {
  return setTimeout(cb, 0) as unknown as number;
});
window.cancelAnimationFrame = vi.fn((id: number) => {
  clearTimeout(id);
});

// ── Mock localStorage ──
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => { store[key] = value; }),
    removeItem: vi.fn((key: string) => { delete store[key]; }),
    clear: vi.fn(() => { store = {}; }),
    get length() { return Object.keys(store).length; },
    key: vi.fn((index: number) => Object.keys(store)[index] ?? null),
  };
})();
Object.defineProperty(window, 'localStorage', { value: localStorageMock });

// ── Mock navigator.connection (for network quality tests) ──
Object.defineProperty(navigator, 'connection', {
  writable: true,
  value: {
    effectiveType: '4g',
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  },
});

// ── Reset all mocks between tests ──
beforeEach(() => {
  vi.clearAllMocks();
  localStorageMock.clear();
});
