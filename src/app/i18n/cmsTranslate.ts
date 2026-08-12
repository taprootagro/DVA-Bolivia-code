import type { Language, Translations } from '../hooks/useLanguage';

/** Resolve dotted path on configManager (e.g. buttons.edit, messages.foo). */
export function resolveNestedKey(obj: unknown, key: string): string | undefined {
  if (!obj || !key) return undefined;
  const parts = key.split('.');
  let val: unknown = obj;
  for (const part of parts) {
    if (val == null || typeof val !== 'object') return undefined;
    val = (val as Record<string, unknown>)[part];
  }
  return typeof val === 'string' ? val : undefined;
}

export type CmsTextOpts = {
  key?: string;
  zh: string;
  en: string;
};

/** Stable slug for message keys derived from English source text. */
export function slugifyMessageKey(en: string): string {
  const base = en
    .replace(/\{[^}]+\}/g, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8)
    .join('_');
  let slug = base.slice(0, 64) || 'msg';
  if (!/^[a-zA-Z_]/.test(slug)) slug = `m_${slug}`;
  return slug.replace(/[^a-zA-Z0-9_]/g, '_');
}

function readConfigManager(t: Translations): Record<string, unknown> | undefined {
  return t.configManager as Record<string, unknown> | undefined;
}

function lookupMessage(
  cm: Record<string, unknown> | undefined,
  key: string | undefined,
  enFallback?: Translations,
): string | undefined {
  if (!key) return undefined;

  const direct = resolveNestedKey(cm, key);
  if (typeof direct === 'string' && direct.length > 0) {
    const enDirect = enFallback ? resolveNestedKey(readConfigManager(enFallback), key) : undefined;
    if (!enDirect || direct !== enDirect) return direct;
  }

  const msgKey = key.startsWith('messages.') ? key.slice('messages.'.length) : key;
  const messages = cm?.messages as Record<string, string> | undefined;
  const val = messages?.[msgKey];
  if (typeof val === 'string' && val.length > 0) {
    const enMessages = readConfigManager(enFallback)?.messages as Record<string, string> | undefined;
    const enVal = enMessages?.[msgKey];
    if (!enVal || val !== enVal) return val;
  }

  return typeof direct === 'string' && direct.length > 0 ? direct : undefined;
}

/**
 * CMS UI string: nested configManager key → messages[key] → zh/zh-TW → en.
 */
export function cmsText(
  t: Translations,
  language: Language,
  opts: CmsTextOpts,
  enFallback?: Translations,
): string {
  const { key, zh, en } = opts;
  const cm = readConfigManager(t);
  const translated = lookupMessage(cm, key, enFallback);
  if (translated) return translated;

  if (key && !key.startsWith('messages.')) {
    const viaMessages = lookupMessage(cm, `messages.${slugifyMessageKey(en)}`, enFallback);
    if (viaMessages) return viaMessages;
  }

  if (!key) {
    const slug = slugifyMessageKey(en);
    const viaSlug = lookupMessage(cm, `messages.${slug}`, enFallback);
    if (viaSlug) return viaSlug;
  }

  if (language === 'zh' || language === 'zh-TW') return zh;
  return en;
}

/** Drop-in replacement for ConfigManager `ct(zh, en)` / `ct(key, zh, en)`. */
export function createCmsTranslator(
  t: Translations,
  language: Language,
  enFallback?: Translations,
): (...args: [string, string] | [string, string, string]) => string {
  return (...args: [string, string] | [string, string, string]): string => {
    if (args.length === 3) {
      const [key, zh, en] = args;
      return cmsText(t, language, { key, zh, en }, enFallback);
    }
    const [zh, en] = args;
    const slug = slugifyMessageKey(en);
    return cmsText(t, language, { key: `messages.${slug}`, zh, en }, enFallback);
  };
}
