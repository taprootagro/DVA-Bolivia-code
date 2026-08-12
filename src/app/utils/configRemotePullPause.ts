/** Nested pause for auto pull (visibility / foreground). Config Manager holds a lease. */
let pauseDepth = 0;

export function pauseConfigRemotePull(): void {
  pauseDepth += 1;
}

export function resumeConfigRemotePull(): void {
  pauseDepth = Math.max(0, pauseDepth - 1);
}

export function isConfigRemotePullPaused(): boolean {
  return pauseDepth > 0;
}
