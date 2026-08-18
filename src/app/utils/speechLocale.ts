import type { Language } from '../hooks/useLanguage';

const SPEECH_TAG_MAP: Record<Language, string> = {
  en: 'en-US',
  zh: 'zh-CN',
  'zh-TW': 'zh-TW',
  es: 'es-ES',
  fr: 'fr-FR',
  ar: 'ar-SA',
  pt: 'pt-BR',
  hi: 'hi-IN',
  ru: 'ru-RU',
  bn: 'bn-IN',
  ur: 'ur-PK',
  id: 'id-ID',
  vi: 'vi-VN',
  ms: 'ms-MY',
  ja: 'ja-JP',
  th: 'th-TH',
  my: 'my-MM',
  tl: 'fil-PH',
  tr: 'tr-TR',
  fa: 'fa-IR',
};

const SPEECH_TAG_FALLBACKS: Record<Language, string[]> = {
  en: ['en-US', 'en-GB', 'en'],
  zh: ['zh-CN', 'zh-Hans', 'zh'],
  'zh-TW': ['zh-TW', 'zh-HK', 'zh'],
  es: ['es-ES', 'es-MX', 'es'],
  fr: ['fr-FR', 'fr-CA', 'fr'],
  ar: ['ar-SA', 'ar-AE', 'ar'],
  pt: ['pt-BR', 'pt-PT', 'pt'],
  hi: ['hi-IN', 'hi'],
  ru: ['ru-RU', 'ru'],
  bn: ['bn-IN', 'bn'],
  ur: ['ur-PK', 'ur'],
  id: ['id-ID', 'id'],
  vi: ['vi-VN', 'vi'],
  ms: ['ms-MY', 'ms'],
  ja: ['ja-JP', 'ja'],
  th: ['th-TH', 'th'],
  my: ['my-MM', 'my'],
  tl: ['fil-PH', 'fil', 'tl-PH', 'tl'],
  tr: ['tr-TR', 'tr'],
  fa: ['fa-IR', 'fa'],
};

const TTS_RATE_MAP: Partial<Record<Language, number>> = {
  zh: 0.92,
  'zh-TW': 0.92,
  ja: 0.92,
  ar: 0.88,
  fa: 0.88,
  ur: 0.88,
  hi: 0.9,
  th: 0.9,
  my: 0.9,
  bn: 0.9,
};

/**
 * Map app UI language to Web Speech API / native STT BCP-47 tags.
 */
export function languageToSpeechTag(lang: Language): string {
  return SPEECH_TAG_MAP[lang] || 'en-US';
}

/** BCP-47 fallback chain for TTS voice matching (most specific first). */
export function speechTagFallbacks(lang: Language): string[] {
  return SPEECH_TAG_FALLBACKS[lang] ?? [languageToSpeechTag(lang), lang.split('-')[0] as string];
}

/** Per-language TTS rate tweak (CJK / RTL slightly slower). */
export function ttsRateForLanguage(lang: Language): number {
  return TTS_RATE_MAP[lang] ?? 1.0;
}
