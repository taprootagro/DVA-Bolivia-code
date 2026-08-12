import { useEffect, useState } from 'react';
import { isNative } from './capacitor-bridge';

/** iPhone 17 / 17 Pro portrait logical width (CSS px). */
export const PHONE_SHELL_WIDTH_PX = 402;

/** Desktop breakpoint: shell only at or above this viewport width. */
export const PHONE_SHELL_MIN_VIEWPORT_PX = 768;

/** Content manager only: full browser width for CMS editing. */
const FULL_BLEED_PREFIXES = ['/config-manager'] as const;

export function isFullBleedPath(pathname: string): boolean {
  return FULL_BLEED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

function readDesktopWide(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia(`(min-width: ${PHONE_SHELL_MIN_VIEWPORT_PX}px)`).matches;
}

export function shouldUsePhoneShell(pathname: string): boolean {
  if (typeof window === 'undefined') return false;
  if (isNative()) return false;
  if (isFullBleedPath(pathname)) return false;
  return readDesktopWide();
}

/**
 * True when desktop wide viewport should wrap the app in PhoneViewportShell.
 * Updates on resize and route changes.
 */
export function usePhoneShellEnabled(pathname: string): boolean {
  const [desktopWide, setDesktopWide] = useState(readDesktopWide);

  useEffect(() => {
    const mq = window.matchMedia(`(min-width: ${PHONE_SHELL_MIN_VIEWPORT_PX}px)`);
    const onChange = () => setDesktopWide(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  if (isNative()) return false;
  if (isFullBleedPath(pathname)) return false;
  return desktopWide;
}
