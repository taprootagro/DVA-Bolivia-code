import { useState, useEffect } from 'react';
import { bridge } from '../utils/capacitor-bridge';

/**
 * Detect virtual keyboard visibility on mobile devices.
 *
 * Strategy:
 * - Primary: Uses visualViewport API: when keyboard opens, visualViewport.height
 *   becomes significantly smaller than window.innerHeight.
 * - Capacitor native: Also listens to @capacitor/keyboard plugin events
 *   (keyboardDidShow / keyboardDidHide) as a reliable fallback, because
 *   Android WebView with adjustResize makes innerHeight and visualViewport.height
 *   shrink together, causing the visualViewport diff to stay near 0.
 * - Threshold: 150px difference (keyboards are typically 250-350px tall).
 * - Falls back to false on desktop / unsupported browsers.
 * - Also monitors focus/blur events on input elements for faster detection.
 */
export function useKeyboardVisible(): boolean {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const vv = window.visualViewport;

    const THRESHOLD = 150; // px — minimum height difference to consider keyboard "open"

    function check() {
      const diff = window.innerHeight - (vv?.height ?? window.innerHeight);
      const isVisible = diff > THRESHOLD;
      setVisible(isVisible);
    }

    if (vv) {
      vv.addEventListener('resize', check);
      vv.addEventListener('scroll', check);
    }

    let capCleanup: (() => void) | null = null;
    let capHideCleanup: (() => void) | null = null;

    void bridge.keyboard.onShow(() => {
      setVisible(true);
    }).then((cleanup) => {
      capCleanup = cleanup;
    });

    void bridge.keyboard.onHide(() => {
      setVisible(false);
    }).then((cleanup) => {
      capHideCleanup = cleanup;
    });

    const handleFocusIn = (e: FocusEvent) => {
      const target = e.target as HTMLElement;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
        const inputType = (target as HTMLInputElement).type;
        if (inputType !== 'checkbox' && inputType !== 'radio' && inputType !== 'range' && inputType !== 'file') {
          requestAnimationFrame(() => {
            if (vv) {
              const diff = window.innerHeight - vv.height;
              if (diff > THRESHOLD) {
                setVisible(true);
              }
            }
          });
          setTimeout(check, 300);
        }
      }
    };

    const handleFocusOut = () => {
      setTimeout(check, 100);
      setTimeout(check, 300);
    };

    document.addEventListener('focusin', handleFocusIn, true);
    document.addEventListener('focusout', handleFocusOut, true);

    check();

    return () => {
      if (vv) {
        vv.removeEventListener('resize', check);
        vv.removeEventListener('scroll', check);
      }
      capCleanup?.();
      capHideCleanup?.();
      document.removeEventListener('focusin', handleFocusIn, true);
      document.removeEventListener('focusout', handleFocusOut, true);
    };
  }, []);

  return visible;
}
