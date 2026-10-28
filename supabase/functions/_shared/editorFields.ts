/** Keep in sync with taprootagrosetting/editorFields.json */
export const EDITOR_FIELD_LIST = [
  "banners",
  "liveStreams",
  "articles",
  "marketPage",
  "filing",
  "aboutUs",
  "privacyPolicy",
  "termsOfService",
  "technicalSupport",
  "appBranding",
  "splashScreen",
  "homeIcons",
  "desktopIcon",
] as const;

export const EDITOR_FIELDS = new Set<string>(EDITOR_FIELD_LIST);

/** Editor POST /config may only overwrite these top-level keys. */
export function applyEditorFieldScope(
  incoming: Record<string, unknown>,
  previous: Record<string, unknown>,
): Record<string, unknown> {
  const scoped = { ...previous };
  for (const key of EDITOR_FIELDS) {
    if (key in incoming) scoped[key] = incoming[key];
  }
  return scoped;
}
