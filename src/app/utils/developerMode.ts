/** Vite dev server only — never exposed in production UI. */
export function isDeveloperMode(): boolean {
  return import.meta.env.DEV;
}
