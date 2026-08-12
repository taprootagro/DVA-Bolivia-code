import type { ReactNode } from 'react';

interface PhoneViewportShellProps {
  children: ReactNode;
}

/**
 * Desktop-only centered viewport (iPhone 17 logical width).
 * No notch / device chrome — layout container only.
 * `transform` creates a containing block so child `fixed` UI stays inside the shell.
 */
export function PhoneViewportShell({ children }: PhoneViewportShellProps) {
  return (
    <div className="phone-shell-outer">
      <div className="phone-shell-inner">{children}</div>
    </div>
  );
}
