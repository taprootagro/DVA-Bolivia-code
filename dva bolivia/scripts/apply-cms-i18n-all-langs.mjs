#!/usr/bin/env node
/**
 * Merge translated configManager into lang/*.ts (minified) and patch formatted zh/es/fr/tl.
 * Uses MyMemory API with per-language cache in src/app/i18n/.cache/
 *
 * node scripts/apply-cms-i18n-all-langs.mjs
 * node scripts/apply-cms-i18n-all-langs.mjs --lang th
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const LANG_DIR = path.join(ROOT, 'src/app/i18n/lang');
const CACHE_DIR = path.join(ROOT, 'src/app/i18n/.cache');

const TARGETS = [
  'zh', 'zh-TW', 'es', 'fr', 'ar', 'pt', 'hi', 'ru', 'bn', 'ur',
  'id', 'vi', 'ms', 'ja', 'th', 'my', 'tl', 'tr', 'fa',
];

const MM = {
  'zh-TW': 'zh-TW', zh: 'zh-CN', es: 'es', fr: 'fr', ar: 'ar', pt: 'pt', hi: 'hi',
  ru: 'ru', bn: 'bn', ur: 'ur', id: 'id', vi: 'vi', ms: 'ms', ja: 'ja', th: 'th',
  my: 'my', tl: 'tl', tr: 'tr', fa: 'fa',
};

const SETTINGS_EN = {
  technicalSupportDesc: 'Provider info and contact',
  technicalSupportText: 'Edit this in Content manager → Legal → Technical support.',
};
const SETTINGS_ZH = {
  technicalSupportDesc: '服务商信息与联系方式',
  technicalSupportText: '请在内容管理器 → 法务信息 → 技术支持 中编辑。',
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function flatten(obj, prefix = '') {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object') Object.assign(out, flatten(v, p));
    else if (typeof v === 'string') out[p] = v;
  }
  return out;
}

function unflatten(flat) {
  const root = {};
  for (const [path, val] of Object.entries(flat)) {
    const parts = path.split('.');
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      cur[parts[i]] = cur[parts[i]] || {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = val;
  }
  return root;
}

async function translateText(text, lang, attempt = 0) {
  if (!text?.trim() || lang === 'en') return text;
  const tl = MM[lang] || lang;
  try {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text.slice(0, 480))}&langpair=en|${encodeURIComponent(tl)}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.responseStatus !== 200) {
      if (attempt < 2) {
        await sleep(500 * (attempt + 1));
        return translateText(text, lang, attempt + 1);
      }
      return text;
    }
    const out = data.responseData?.translatedText || text;
    if (out === text && attempt < 2 && text.split(/\s+/).length >= 2) {
      await sleep(400);
      return translateText(text, lang, attempt + 1);
    }
    return out;
  } catch {
    if (attempt < 3) {
      await sleep(800 * (attempt + 1));
      return translateText(text, lang, attempt + 1);
    }
    return text;
  }
}

const POOL = 3;

async function mapPool(items, fn, concurrency = POOL) {
  const out = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return out;
}

async function buildFlatForLang(enFlat, lang, zhFlat) {
  const cacheFile = path.join(CACHE_DIR, `flat-${lang}.json`);
  let cached = fs.existsSync(cacheFile)
    ? JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
    : null;

  const keys = Object.keys(enFlat);
  if (lang === 'zh') {
    const out = {};
    for (const k of keys) out[k] = zhFlat[k] || enFlat[k];
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(out, null, 2));
    return out;
  }
  if (lang === 'zh-TW') {
    const out = {};
    for (const k of keys) out[k] = zhFlat[k] || enFlat[k];
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(out, null, 2));
    return out;
  }

  const missing = cached ? keys.filter((k) => !(k in cached)) : keys;
  if (cached && missing.length === 0) {
    console.log(`[cache hit] ${lang}`);
    return cached;
  }
  if (cached && missing.length > 0) {
    console.log(`[cache merge] ${lang} +${missing.length} keys`);
  } else {
    console.log(`[translate] ${lang} (${keys.length} keys, pool=${POOL})`);
  }

  const out = { ...(cached || {}) };
  const toTranslate = missing;
  const pairs = await mapPool(
    toTranslate,
    async (k) => {
      await sleep(80 + Math.random() * 40);
      const text = await translateText(enFlat[k], lang);
      return [k, text];
    },
    POOL,
  );
  for (const [k, v] of pairs) out[k] = v;

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify(out, null, 2));
  return out;
}

function extractSectionBody(raw, name) {
  const startRe = new RegExp(`${name}:\\s*\\{`);
  const start = raw.search(startRe);
  if (start < 0) return null;
  const bs = raw.indexOf('{', start);
  let depth = 0;
  for (let i = bs; i < raw.length; i++) {
    if (raw[i] === '{') depth++;
    else if (raw[i] === '}') {
      depth--;
      if (depth === 0) return raw.slice(bs + 1, i);
    }
  }
  return null;
}

function parseKeyValues(body) {
  const out = {};
  if (!body) return out;
  const singleRe = /(\w+):\s*'((?:\\'|[^'])*)'/g;
  let r;
  while ((r = singleRe.exec(body))) {
    out[r[1]] = r[2].replace(/\\'/g, "'").replace(/\\n/g, '\n');
  }
  const mlRe = /(\w+):\s*\n\s*'((?:\\'|[^'])*)'/g;
  while ((r = mlRe.exec(body))) {
    if (!(r[1] in out)) out[r[1]] = r[2].replace(/\\'/g, "'");
  }
  return out;
}

function extractFlatSection(raw, name) {
  return parseKeyValues(extractSectionBody(raw, name));
}

function extractMultilineSection(raw, name) {
  return parseKeyValues(extractSectionBody(raw, name));
}

function loadEnCm() {
  const messages = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'src/app/i18n/cms-messages.en.json'), 'utf8'),
  );
  const enRaw = fs.readFileSync(path.join(LANG_DIR, 'en.ts'), 'utf8');
  return {
    sidebar: extractFlatSection(enRaw, 'sidebar'),
    navItems: extractFlatSection(enRaw, 'navItems'),
    topBar: extractFlatSection(enRaw, 'topBar'),
    buttons: extractFlatSection(enRaw, 'buttons'),
    headers: extractFlatSection(enRaw, 'headers'),
    commonLabels: extractFlatSection(enRaw, 'commonLabels'),
    pushNotification: extractMultilineSection(enRaw, 'pushNotification'),
    messages,
  };
}

function injectMinified(raw, cm) {
  const ser = `"configManager":${JSON.stringify(cm)}`;
  const marker = '"configManager":{';
  const idx = raw.lastIndexOf(marker);
  if (idx < 0) {
    const pos = raw.lastIndexOf('};export');
    return raw.slice(0, pos) + `,${ser}` + raw.slice(pos);
  }
  let depth = 0;
  const bs = raw.indexOf('{', idx + '"configManager":'.length);
  for (let i = bs; i < raw.length; i++) {
    if (raw[i] === '{') depth++;
    else if (raw[i] === '}') {
      depth--;
      if (depth === 0) return raw.slice(0, idx) + ser + raw.slice(i + 1);
    }
  }
  throw new Error('inject failed');
}

function patchSettings(raw, lang, flat) {
  const desc = flat['settings.technicalSupportDesc'] || (lang === 'zh' || lang === 'zh-TW' ? SETTINGS_ZH.technicalSupportDesc : SETTINGS_EN.technicalSupportDesc);
  const text = flat['settings.technicalSupportText'] || (lang === 'zh' || lang === 'zh-TW' ? SETTINGS_ZH.technicalSupportText : SETTINGS_EN.technicalSupportText);
  let out = raw;
  for (const [key, val] of [
    ['technicalSupportDesc', desc],
    ['technicalSupportText', text],
  ]) {
    const esc = val.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    if (out.includes(`"${key}"`)) {
      out = out.replace(new RegExp(`"${key}":"[^"]*"`), `"${key}":"${esc}"`);
    } else {
      const anchor = out.indexOf('},"login":');
      if (anchor > 0) {
        out = out.slice(0, anchor) + `,"${key}":"${esc}"` + out.slice(anchor);
      }
    }
  }
  return out;
}

function escTs(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function renderSection(obj, indent) {
  return Object.entries(obj || {})
    .map(([k, v]) => `${indent}${k}: '${escTs(v)}',`)
    .join('\n');
}

function renderFormattedCm(cm) {
  const sections = ['sidebar', 'navItems', 'topBar', 'buttons', 'headers', 'commonLabels', 'pushNotification'];
  let body = sections
    .filter((s) => cm[s] && Object.keys(cm[s]).length)
    .map((s) => `      ${s}: {\n${renderSection(cm[s], '        ')}\n      },`)
    .join('\n');
  if (cm.messages && Object.keys(cm.messages).length) {
    const msgLines = Object.entries(cm.messages)
      .map(([k, v]) => `        ${k}: '${escTs(v)}',`)
      .join('\n');
    body += `\n      messages: {\n${msgLines}\n      },`;
  }
  return `    configManager: {\n${body}\n    },`;
}

function patchFormattedFile(lang, cm, flat) {
  const fp = path.join(LANG_DIR, `${lang}.ts`);
  let raw = fs.readFileSync(fp, 'utf8');
  const cmBlock = renderFormattedCm(cm);
  if (raw.match(/configManager:\s*\{/)) {
    raw = raw.replace(/configManager:\s*\{[\s\S]*?\n    \},/, cmBlock);
  } else {
    raw = raw.replace(/\n};\n\nexport default/, `\n${cmBlock}\n};\n\nexport default`);
  }
  for (const [key, flatKey] of [
    ['technicalSupportDesc', 'settings.technicalSupportDesc'],
    ['technicalSupportText', 'settings.technicalSupportText'],
  ]) {
    const val = flat[flatKey] || SETTINGS_EN[key];
    const esc = escTs(val);
    if (raw.includes(`${key}:`)) {
      raw = raw.replace(new RegExp(`${key}:\\s*'[^']*'`), `${key}: '${esc}'`);
    } else {
      raw = raw.replace(/(termsOfServiceText:\s*'[^']*',)/, `$1\n      ${key}: '${esc}',`);
    }
  }
  fs.writeFileSync(fp, raw, 'utf8');
  console.log(`[formatted] ${lang}.ts`);
}

async function main() {
  const only = process.argv.includes('--lang') ? process.argv[process.argv.indexOf('--lang') + 1] : null;
  const enCm = loadEnCm();
  const enFlat = {
    ...flatten(enCm),
    'settings.technicalSupportDesc': SETTINGS_EN.technicalSupportDesc,
    'settings.technicalSupportText': SETTINGS_EN.technicalSupportText,
  };
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(path.join(CACHE_DIR, 'flat-en.json'), JSON.stringify(enFlat, null, 2));
  const zhRaw = fs.readFileSync(path.join(LANG_DIR, 'zh.ts'), 'utf8');
  const zhCmParsed = {
    sidebar: extractFlatSection(zhRaw, 'sidebar'),
    navItems: extractFlatSection(zhRaw, 'navItems'),
    topBar: extractFlatSection(zhRaw, 'topBar'),
    buttons: extractFlatSection(zhRaw, 'buttons'),
    headers: extractFlatSection(zhRaw, 'headers'),
    commonLabels: extractFlatSection(zhRaw, 'commonLabels'),
    pushNotification: extractMultilineSection(zhRaw, 'pushNotification'),
    messages: JSON.parse(fs.readFileSync(path.join(ROOT, 'src/app/i18n/cms-messages.zh.json'), 'utf8')),
  };
  const zhFlat = flatten(zhCmParsed);
  Object.assign(zhFlat, {
    'settings.technicalSupportDesc': SETTINGS_ZH.technicalSupportDesc,
    'settings.technicalSupportText': SETTINGS_ZH.technicalSupportText,
  });

  const skipArg = process.argv.includes('--skip')
    ? process.argv[process.argv.indexOf('--skip') + 1] || ''
    : '';
  const skip = new Set(skipArg.split(',').filter(Boolean));
  const langs = only ? [only] : TARGETS.filter((l) => !skip.has(l));

  for (const lang of langs) {
    console.log(`\n== ${lang} ==`);
    const flat = await buildFlatForLang(enFlat, lang, zhFlat);
    const cmFlat = Object.fromEntries(
      Object.entries(flat).filter(([k]) => !k.startsWith('settings.')),
    );
    const cm = unflatten(cmFlat);
    if (!cm.messages) cm.messages = enCm.messages;

    const fp = path.join(LANG_DIR, `${lang}.ts`);
    let raw = fs.readFileSync(fp, 'utf8');
    if (raw.split('\n').length <= 15) {
      raw = injectMinified(raw, cm);
      raw = patchSettings(raw, lang, flat);
      fs.writeFileSync(fp, raw, 'utf8');
      console.log(`[minified] ${lang}.ts`);
    } else {
      patchFormattedFile(lang, cm, flat);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
