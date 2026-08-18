import { describe, expect, it } from 'vitest';
import {
  pickBestVoice,
  resolveVoiceForLang,
  resolveVoiceForLangOrDefault,
  scoreVoice,
  type VoiceLike,
} from '../ttsVoice';

function voice(
  name: string,
  lang: string,
  extra: Partial<VoiceLike> = {},
): VoiceLike {
  return { name, lang, ...extra };
}

describe('scoreVoice', () => {
  it('returns -1 for cross-language voices', () => {
    expect(scoreVoice(voice('Daniel', 'en-US'), 'zh-CN')).toBe(-1);
  });

  it('prefers exact BCP-47 match over prefix match', () => {
    const exact = scoreVoice(voice('Meijia', 'zh-CN'), 'zh-CN');
    const prefix = scoreVoice(voice('Ting-Ting', 'zh-TW'), 'zh-CN');
    expect(exact).toBeGreaterThan(prefix);
  });

  it('boosts premium/neural voice names', () => {
    const premium = scoreVoice(voice('Google US English Neural', 'en-US'), 'en-US');
    const basic = scoreVoice(voice('Fred', 'en-US'), 'en-US');
    expect(premium).toBeGreaterThan(basic);
  });

  it('returns -1 for empty voice or target lang', () => {
    expect(scoreVoice(voice('Daniel', ''), 'en-US')).toBe(-1);
    expect(scoreVoice(voice('Daniel', 'en-US'), '')).toBe(-1);
  });

  it('penalizes compact/robot voice names', () => {
    const robot = scoreVoice(voice('Compact Robot Voice', 'en-US'), 'en-US');
    const normal = scoreVoice(voice('Samantha', 'en-US'), 'en-US');
    expect(normal).toBeGreaterThan(robot);
  });
});

describe('pickBestVoice', () => {
  it('selects highest-scoring same-language voice', () => {
    const voices = [
      voice('Daniel', 'en-US'),
      voice('Samantha', 'en-US', { default: true }),
      voice('Google US English Neural', 'en-US'),
    ];
    const best = pickBestVoice(voices, 'en-US');
    expect(best?.name).toBe('Google US English Neural');
  });

  it('returns null when no same-language voice exists', () => {
    const voices = [voice('Daniel', 'en-US'), voice('Karen', 'en-AU')];
    expect(pickBestVoice(voices, 'zh-CN')).toBeNull();
  });
});

describe('resolveVoiceForLang', () => {
  it('walks fallback chain when primary tag is missing', () => {
    const voices = [
      voice('Daniel', 'en-US'),
      voice('Kyoko', 'ja-JP'),
    ];
    const resolved = resolveVoiceForLang(voices, ['zh-CN', 'ja-JP', 'ja']);
    expect(resolved?.voice.name).toBe('Kyoko');
    expect(resolved?.lang).toBe('ja-JP');
  });

  it('returns null when no fallback tag matches', () => {
    const voices = [voice('Daniel', 'en-US')];
    expect(resolveVoiceForLang(voices, ['zh-CN', 'zh-Hans', 'zh'])).toBeNull();
  });

  it('includes voice index in original voices array', () => {
    const voices = [
      voice('Daniel', 'en-US'),
      voice('Samantha', 'en-US'),
    ];
    const resolved = resolveVoiceForLang(voices, ['en-US']);
    expect(resolved?.voiceIndex).toBe(1);
  });
});

describe('resolveVoiceForLangOrDefault', () => {
  it('returns the language match when one exists', () => {
    const voices = [voice('Daniel', 'en-US'), voice('Monica', 'es-ES')];
    const resolved = resolveVoiceForLangOrDefault(voices, ['es-BO', 'es-ES', 'es']);
    expect(resolved?.voice.name).toBe('Monica');
    expect(resolved?.lang).toBe('es-BO');
  });

  it('falls back to the first listed voice when no language matches', () => {
    const voices = [voice('Daniel', 'en-US')];
    const resolved = resolveVoiceForLangOrDefault(voices, ['zh-CN', 'zh']);
    expect(resolved?.voice.name).toBe('Daniel');
    expect(resolved?.voiceIndex).toBe(0);
    expect(resolved?.lang).toBe('zh-CN');
  });

  it('returns null when the device has no voices', () => {
    expect(resolveVoiceForLangOrDefault([], ['es-ES'])).toBeNull();
  });
});
