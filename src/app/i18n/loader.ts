/**
 * Lazy Translation Loader
 * 
 * Provides per-language-group code splitting for translations.
 * English is always inline (in useLanguage.tsx); other languages
 * are loaded on demand and cached in memory.
 * 
 * Architecture:
 *   - Initial bundle: English only (~400 lines)
 *   - On language switch: load the required language chunk
 *   - Chunks are cached after first load (no re-fetch)
 *   - Falls back to English while loading
 */

import type { Translations, Language } from '../hooks/useLanguage';

// In-memory cache for loaded translations
const cache = new Map<Language, Translations>();

/**
 * Load translations for a given language.
 * Returns cached data if available, otherwise dynamically imports.
 * Returns null for 'en' (English is always inline).
 */
export async function loadTranslations(lang: Language): Promise<Translations | null> {
  // English is inline, no need to load
  if (lang === 'en') return null;

  // Return from cache if available
  const cached = cache.get(lang);
  if (cached) return cached;

  try {
    // Dynamic import — Vite will code-split each file into its own chunk
    const mod = await getLanguageModule(lang);
    if (mod) {
      cache.set(lang, mod);
      return mod;
    }
  } catch (err) {
    console.warn(`[i18n] Failed to load translations for "${lang}", falling back to English`, err);
  }

  return null;
}

/**
 * Check if translations for a language are already cached.
 */
export function isTranslationCached(lang: Language): boolean {
  return lang === 'en' || cache.has(lang);
}

/**
 * Get cached translations (synchronous). Returns undefined if not cached.
 */
export function getCachedTranslation(lang: Language): Translations | undefined {
  return cache.get(lang);
}

/**
 * Preload translations for a language (e.g., on hover over language selector).
 */
export function preloadTranslations(lang: Language): void {
  if (lang !== 'en' && !cache.has(lang)) {
    loadTranslations(lang).catch(() => {
      // Silently fail on preload
    });
  }
}

// ---- Internal: Dynamic import mapping ----
// Uses import.meta.glob to safely create chunks in Vite

const languageModules = import.meta.glob('./lang/*.ts');

async function getLanguageModule(lang: Language, retries = 2): Promise<Translations | null> {
  try {
    const importFn = languageModules[`./lang/${lang}.ts`];
    if (importFn) {
      console.log(`[i18n] Importing language module for ${lang}`);
      const module = await importFn() as { default: Translations };
      return module.default;
    }
    return null;
  } catch (err) {
    // If chunk load fails (e.g., due to new deployment), try reloading
    if (retries > 0) {
      console.warn(`[i18n] Module import failed for ${lang}, retrying... (${retries} attempts left)`, err);
      // Force cache busting by adding a query string if possible? importFn is just a function.
      await new Promise(resolve => setTimeout(resolve, 800));
      return getLanguageModule(lang, retries - 1);
    }
    console.error(`[i18n] Module import failed for ${lang} after retries:`, err);
    return null;
  }
}
