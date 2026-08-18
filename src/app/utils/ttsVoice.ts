/**
 * TTS voice selection — shared scoring/resolution for Web speechSynthesis and native plugin.
 */

export type VoiceLike = {
  name: string;
  lang: string;
  default?: boolean;
  localService?: boolean;
  voiceURI?: string;
};

export type ResolvedVoice<T extends VoiceLike = VoiceLike> = {
  voice: T;
  voiceIndex: number;
  lang: string;
};

const QUALITY_BONUS_RE =
  /premium|enhanced|neural|natural|wavenet|siri|google/i;
const QUALITY_PENALTY_RE = /compact|low|robot|espeak|synthetic/i;
const KNOWN_GOOD_RE =
  /ting-ting|meijia|sin-ji|yuna|samantha|karen|moira|zira|heera|kyoko|luciana|monica|paulina|thomas|amélie|maged|tarik|lekha|tessa|veena|damayanti|milena|yuri|anna|melina|nora|ellen|xander|maria|joana|sara|fiona|veena|rishi|grandpa|grandma|flo|sandy|shelley|grandpa|superstar|rocko|sandy|reed|sandy|grandpa|grandma|grandpa|grandma/i;

function normalizeLang(lang: string): string {
  return (lang || '').toLowerCase().replace(/_/g, '-');
}

function langPrefix(lang: string): string {
  return normalizeLang(lang).split('-')[0];
}

/** Score a voice for a target BCP-47 tag; cross-language voices return -1. */
export function scoreVoice(v: VoiceLike, targetLang: string): number {
  const voiceLang = normalizeLang(v.lang);
  const target = normalizeLang(targetLang);
  if (!voiceLang || !target) return -1;
  const prefix = langPrefix(target);
  const region = target.split('-')[1];

  let score = 0;
  if (voiceLang === target) {
    score += 100;
  } else if (voiceLang.startsWith(prefix + '-')) {
    score += 80;
  } else if (voiceLang === prefix) {
    score += 60;
  } else {
    return -1;
  }

  if (region && voiceLang.includes(region)) score += 10;

  const name = v.name.toLowerCase();
  if (QUALITY_BONUS_RE.test(name)) score += 25;
  if (QUALITY_PENALTY_RE.test(name)) score -= 30;
  if (KNOWN_GOOD_RE.test(name)) score += 15;

  if (v.default) score += 5;
  if (v.localService) score += 3;

  return score;
}

/** Pick highest-scoring voice for one BCP-47 tag; no cross-language fallback. */
export function pickBestVoice<T extends VoiceLike>(
  voices: T[],
  lang: string,
): T | null {
  if (!voices.length) return null;

  let best: T | null = null;
  let bestScore = -1;

  for (const v of voices) {
    const s = scoreVoice(v, lang);
    if (s > bestScore) {
      bestScore = s;
      best = v;
    }
  }

  return bestScore >= 0 ? best : null;
}

/** Try each tag in fallback chain; return first match with index in voices array. */
export function resolveVoiceForLang<T extends VoiceLike>(
  voices: T[],
  langTags: string[],
): ResolvedVoice<T> | null {
  for (const tag of langTags) {
    const voice = pickBestVoice(voices, tag);
    if (voice) {
      const voiceIndex = voices.indexOf(voice);
      return { voice, voiceIndex: voiceIndex >= 0 ? voiceIndex : 0, lang: tag };
    }
  }
  return null;
}

/** Last-resort: first listed voice, still tagged with the requested language. */
export function resolveVoiceForLangOrDefault<T extends VoiceLike>(
  voices: T[],
  langTags: string[],
): ResolvedVoice<T> | null {
  const matched = resolveVoiceForLang(voices, langTags);
  if (matched) return matched;
  if (!voices.length) return null;
  return { voice: voices[0], voiceIndex: 0, lang: langTags[0] || voices[0].lang };
}

// ── Web speechSynthesis voice cache ───────────────────────────────────────

let cachedWebVoices: SpeechSynthesisVoice[] | null = null;
let webVoicesReadyPromise: Promise<SpeechSynthesisVoice[]> | null = null;

export function invalidateVoiceCache(): void {
  cachedWebVoices = null;
  webVoicesReadyPromise = null;
}

export function loadVoicesWeb(): Promise<SpeechSynthesisVoice[]> {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
    return Promise.resolve([]);
  }
  if (cachedWebVoices && cachedWebVoices.length > 0) {
    return Promise.resolve(cachedWebVoices);
  }
  if (webVoicesReadyPromise) return webVoicesReadyPromise;

  webVoicesReadyPromise = new Promise((resolve) => {
    const finish = (list: SpeechSynthesisVoice[]) => {
      cachedWebVoices = list;
      resolve(list);
    };

    const initial = window.speechSynthesis.getVoices();
    if (initial && initial.length > 0) {
      finish(initial);
      return;
    }

    const timeout = setTimeout(() => {
      finish(window.speechSynthesis.getVoices());
    }, 3000);

    const onChange = () => {
      clearTimeout(timeout);
      const list = window.speechSynthesis.getVoices();
      window.speechSynthesis.removeEventListener('voiceschanged', onChange);
      finish(list);
    };
    window.speechSynthesis.addEventListener('voiceschanged', onChange);
  });

  return webVoicesReadyPromise;
}

/** Warm Web voice list (native warm-up lives in capacitor-bridge). */
export async function preloadVoicesWeb(): Promise<void> {
  await loadVoicesWeb();
}
