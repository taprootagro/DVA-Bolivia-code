export type PhoneParts = { dial: string; national: string };

/** App markets + Bolivia; unique by dial, longest-first when parsing. */
export const PROFILE_DIAL_CODES: { iso: string; dial: string }[] = [
  { iso: "CN", dial: "86" },
  { iso: "BO", dial: "591" },
  { iso: "TW", dial: "886" },
  { iso: "HK", dial: "852" },
  { iso: "MO", dial: "853" },
  { iso: "US", dial: "1" },
  { iso: "GB", dial: "44" },
  { iso: "FR", dial: "33" },
  { iso: "DE", dial: "49" },
  { iso: "ES", dial: "34" },
  { iso: "IT", dial: "39" },
  { iso: "PT", dial: "351" },
  { iso: "RU", dial: "7" },
  { iso: "TR", dial: "90" },
  { iso: "JP", dial: "81" },
  { iso: "KR", dial: "82" },
  { iso: "TH", dial: "66" },
  { iso: "VN", dial: "84" },
  { iso: "ID", dial: "62" },
  { iso: "MY", dial: "60" },
  { iso: "SG", dial: "65" },
  { iso: "PH", dial: "63" },
  { iso: "MM", dial: "95" },
  { iso: "IN", dial: "91" },
  { iso: "BD", dial: "880" },
  { iso: "PK", dial: "92" },
  { iso: "IR", dial: "98" },
  { iso: "SA", dial: "966" },
  { iso: "AE", dial: "971" },
  { iso: "EG", dial: "20" },
  { iso: "NG", dial: "234" },
  { iso: "ZA", dial: "27" },
  { iso: "AU", dial: "61" },
  { iso: "NZ", dial: "64" },
  { iso: "BR", dial: "55" },
  { iso: "MX", dial: "52" },
  { iso: "PE", dial: "51" },
  { iso: "AR", dial: "54" },
  { iso: "CL", dial: "56" },
  { iso: "CO", dial: "57" },
  { iso: "EC", dial: "593" },
  { iso: "PY", dial: "595" },
  { iso: "UY", dial: "598" },
  { iso: "VE", dial: "58" },
];

const DIALS_LONGEST_FIRST = [...PROFILE_DIAL_CODES]
  .map((c) => c.dial)
  .sort((a, b) => b.length - a.length);

export function defaultDialForLanguage(lang: string): string {
  switch (lang) {
    case "zh":
      return "86";
    case "zh-TW":
      return "886";
    case "es":
      return "591";
    case "pt":
      return "55";
    case "en":
      return "1";
    case "fr":
      return "33";
    case "ja":
      return "81";
    case "th":
      return "66";
    case "vi":
      return "84";
    case "id":
      return "62";
    case "ms":
      return "60";
    case "my":
      return "95";
    case "hi":
      return "91";
    case "bn":
      return "880";
    case "ur":
      return "92";
    case "ar":
      return "966";
    case "fa":
      return "98";
    case "ru":
      return "7";
    case "tr":
      return "90";
    case "tl":
      return "63";
    default:
      return "86";
  }
}

export function parsePhoneParts(raw: string, fallbackDial: string): PhoneParts {
  const trimmed = raw.trim();
  const fallback = fallbackDial.replace(/\D/g, "") || "86";
  if (!trimmed) return { dial: fallback, national: "" };

  const compact = trimmed.replace(/[^\d+]/g, "");
  const digits = compact.replace(/^\+/, "");
  if (!digits) return { dial: fallback, national: "" };

  const hasPlus = compact.startsWith("+") || trimmed.startsWith("+");
  if (hasPlus) {
    for (const d of DIALS_LONGEST_FIRST) {
      if (digits.startsWith(d) && digits.length > d.length) {
        return { dial: d, national: digits.slice(d.length) };
      }
    }
    for (const len of [3, 2, 1]) {
      if (digits.length > len) {
        return { dial: digits.slice(0, len), national: digits.slice(len) };
      }
    }
  }

  if (/^1\d{10}$/.test(digits)) {
    return { dial: "86", national: digits };
  }

  return { dial: fallback, national: digits };
}

/** Persist as `+86 15012345678`. Empty national → empty string. */
export function formatStoredPhone(dial: string, national: string): string {
  const d = dial.replace(/\D/g, "");
  const n = national.replace(/\D/g, "");
  if (!n) return "";
  if (!d) return n;
  return `+${d} ${n}`;
}

export function formatPhoneForDisplay(raw: string, fallbackDial = "86"): string {
  const parts = parsePhoneParts(raw, fallbackDial);
  return formatStoredPhone(parts.dial, parts.national) || raw.trim();
}

export function isValidProfilePhoneParts(dial: string, national: string): boolean {
  const d = dial.replace(/\D/g, "");
  const n = national.replace(/\D/g, "");
  if (!n) return true;
  if (!/^\d{1,4}$/.test(d)) return false;
  if (!/^\d{4,15}$/.test(n)) return false;
  return d.length + n.length <= 15;
}

export function dialSelectOptions(currentDial: string): { iso: string; dial: string }[] {
  const d = currentDial.replace(/\D/g, "");
  if (d && !PROFILE_DIAL_CODES.some((c) => c.dial === d)) {
    return [{ iso: "", dial: d }, ...PROFILE_DIAL_CODES];
  }
  return PROFILE_DIAL_CODES;
}

/** 用户手输区号：精确匹配已知号段；否则保留已输入数字。 */
export function matchDialFromInput(raw: string): { dial: string; iso: string } {
  const digits = raw.replace(/\D/g, "").slice(0, 4);
  if (!digits) return { dial: "", iso: "" };
  const exact = PROFILE_DIAL_CODES.find((c) => c.dial === digits);
  if (exact) return { dial: exact.dial, iso: exact.iso };
  return { dial: digits, iso: "" };
}
