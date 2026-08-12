#!/usr/bin/env node
/**
 * Inject critical visible CMS/settings strings (~85 keys) from bundled offline translations.
 * Long-tail messages.* stay English (cmsTranslate falls back to en).
 *
 * node scripts/apply-cms-i18n-critical.mjs
 * node scripts/apply-cms-i18n-critical.mjs --lang th
 * node scripts/apply-cms-i18n-critical.mjs --force
 * node scripts/apply-cms-i18n-critical.mjs --online   # optional MyMemory fallback (slow)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const LANG_DIR = path.join(ROOT, 'src/app/i18n/lang');
const CACHE_DIR = path.join(ROOT, 'src/app/i18n/.cache');
const BUNDLED_DIR = path.join(ROOT, 'src/app/i18n/cms-critical-bundled');

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

const CRITICAL = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'src/app/i18n/cms-critical-keys.json'), 'utf8'),
);

const argv = process.argv.slice(2);
const FORCE = argv.includes('--force');
const ONLINE = argv.includes('--online');
const only = argv.includes('--lang') ? argv[argv.indexOf('--lang') + 1] : null;

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
  for (const [pathKey, val] of Object.entries(flat)) {
    const parts = pathKey.split('.');
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      cur[parts[i]] = cur[parts[i]] || {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = val;
  }
  return root;
}

function isCriticalKey(k) {
  if (k === 'settings.technicalSupportDesc' || k === 'settings.technicalSupportText') return true;
  for (const sec of CRITICAL.sections) {
    if (k.startsWith(`${sec}.`)) return true;
  }
  if (k.startsWith('pushNotification.')) {
    const sub = k.slice('pushNotification.'.length);
    return CRITICAL.pushNotification.includes(sub);
  }
  return false;
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

function loadEnCritical() {
  const enRaw = fs.readFileSync(path.join(LANG_DIR, 'en.ts'), 'utf8');
  const cm = {};
  for (const sec of [...CRITICAL.sections, 'pushNotification']) {
    cm[sec] = parseKeyValues(extractSectionBody(enRaw, sec));
  }
  const flat = flatten(cm);
  flat['settings.technicalSupportDesc'] = SETTINGS_EN.technicalSupportDesc;
  flat['settings.technicalSupportText'] = SETTINGS_EN.technicalSupportText;
  return { cm, flat: Object.fromEntries(Object.entries(flat).filter(([k]) => isCriticalKey(k))) };
}

const ZH_TW_OVERRIDES = {
  'topBar.title': '內容管理器',
  'headers.title': '標題',
  'headers.description': '描述',
};

function loadZhCritical(force = false) {
  const zhCache = path.join(CACHE_DIR, 'critical-zh.json');
  if (!force && fs.existsSync(zhCache)) {
    return JSON.parse(fs.readFileSync(zhCache, 'utf8'));
  }
  const zhRaw = fs.readFileSync(path.join(LANG_DIR, 'zh.ts'), 'utf8');
  const cm = {};
  for (const sec of [...CRITICAL.sections, 'pushNotification']) {
    cm[sec] = parseKeyValues(extractSectionBody(zhRaw, sec));
  }
  const flat = flatten(cm);
  flat['settings.technicalSupportDesc'] = SETTINGS_ZH.technicalSupportDesc;
  flat['settings.technicalSupportText'] = SETTINGS_ZH.technicalSupportText;
  return Object.fromEntries(Object.entries(flat).filter(([k]) => isCriticalKey(k)));
}

function loadBundled(lang) {
  const fp = path.join(BUNDLED_DIR, `${lang}.json`);
  if (!fs.existsSync(fp)) return null;
  return JSON.parse(fs.readFileSync(fp, 'utf8'));
}

async function translateText(text, lang, attempt = 0) {
  if (!text?.trim() || lang === 'en') return text;
  const tl = MM[lang] || lang;
  try {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text.slice(0, 480))}&langpair=en|${encodeURIComponent(tl)}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.responseStatus !== 200) throw new Error('status');
    return data.responseData?.translatedText || text;
  } catch {
    if (attempt < 2) {
      await sleep(600 * (attempt + 1));
      return translateText(text, lang, attempt + 1);
    }
    return text;
  }
}

async function buildCriticalFlat(enFlat, lang, zhFlat) {
  const cacheFile = path.join(CACHE_DIR, `critical-${lang}.json`);
  if (!FORCE && fs.existsSync(cacheFile)) {
    console.log(`[cache] ${lang}`);
    return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  }

  const keys = Object.keys(enFlat);
  const out = {};

  if (lang === 'zh' || lang === 'zh-TW') {
    console.log(`[zh] ${lang}`);
    for (const k of keys) out[k] = zhFlat[k] || enFlat[k];
    if (lang === 'zh-TW') Object.assign(out, ZH_TW_OVERRIDES);
  } else {
    const bundled = loadBundled(lang);
    if (bundled) {
      console.log(`[bundled] ${lang}`);
      for (const k of keys) out[k] = bundled[k] || enFlat[k];
    } else if (ONLINE) {
      console.log(`[translate online] ${lang} (${keys.length} critical keys)`);
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        out[k] = await translateText(enFlat[k], lang);
        if (i % 10 === 9) {
          console.log(`  ${lang}: ${i + 1}/${keys.length}`);
          await sleep(200);
        } else {
          await sleep(120);
        }
      }
    } else {
      console.log(`[fallback en] ${lang} (no bundled file)`);
      for (const k of keys) out[k] = enFlat[k];
    }
  }

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify(out, null, 2));
  return out;
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

function patchSettings(raw, flat) {
  let out = raw;
  for (const [key, flatKey] of [
    ['technicalSupportDesc', 'settings.technicalSupportDesc'],
    ['technicalSupportText', 'settings.technicalSupportText'],
  ]) {
    const val = flat[flatKey];
    if (!val) continue;
    const esc = val.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    if (out.includes(`"${key}"`)) {
      out = out.replace(new RegExp(`"${key}":"[^"]*"`), `"${key}":"${esc}"`);
    } else if (out.includes(`${key}:`)) {
      out = out.replace(new RegExp(`${key}:\\s*'[^']*'`), `${key}: '${val.replace(/'/g, "\\'")}'`);
    } else {
      const anchor = out.indexOf('},"login":');
      if (anchor > 0) out = out.slice(0, anchor) + `,"${key}":"${esc}"` + out.slice(anchor);
    }
  }
  return out;
}

function escTs(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function renderFormattedCm(cm) {
  const lines = [];
  for (const sec of [...CRITICAL.sections, 'pushNotification']) {
    if (!cm[sec] || !Object.keys(cm[sec]).length) continue;
    const inner = Object.entries(cm[sec])
      .map(([k, v]) => `        ${k}: '${escTs(v)}',`)
      .join('\n');
    lines.push(`      ${sec}: {\n${inner}\n      },`);
  }
  if (cm.messages && Object.keys(cm.messages).length) {
    const msgLines = Object.entries(cm.messages)
      .map(([k, v]) => `        ${k}: '${escTs(v)}',`)
      .join('\n');
    lines.push(`      messages: {\n${msgLines}\n      },`);
  }
  return `    configManager: {\n${lines.join('\n')}\n    }`;
}

function replaceFormattedConfigManager(raw, block) {
  const re = /configManager:\s*\{/;
  const start = raw.search(re);
  if (start < 0) return null;
  const bs = raw.indexOf('{', start);
  let depth = 0;
  for (let i = bs; i < raw.length; i++) {
    if (raw[i] === '{') depth++;
    else if (raw[i] === '}') {
      depth--;
      if (depth === 0) return raw.slice(0, start) + block + raw.slice(i + 1);
    }
  }
  return null;
}

function patchFormatted(lang, cm, flat) {
  const fp = path.join(LANG_DIR, `${lang}.ts`);
  let raw = fs.readFileSync(fp, 'utf8');
  if (lang === 'zh' || lang === 'zh-TW') {
    const zhMsg = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'src/app/i18n/cms-messages.zh.json'), 'utf8'),
    );
    cm.messages = zhMsg;
  }
  const block = renderFormattedCm(cm);
  if (raw.match(/configManager:\s*\{/)) {
    const next = replaceFormattedConfigManager(raw, block);
    if (!next) throw new Error(`configManager replace failed: ${lang}.ts`);
    raw = next;
  } else {
    raw = raw.replace(/\n};\n\nexport default/, `\n${block}\n};\n\nexport default`);
  }
  for (const [key, flatKey] of [
    ['technicalSupportDesc', 'settings.technicalSupportDesc'],
    ['technicalSupportText', 'settings.technicalSupportText'],
  ]) {
    const val = flat[flatKey];
    if (!val) continue;
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
  const { flat: enFlat } = loadEnCritical();
  const zhFlat = loadZhCritical(FORCE);
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(path.join(CACHE_DIR, 'critical-en.json'), JSON.stringify(enFlat, null, 2));
  if (!fs.existsSync(path.join(CACHE_DIR, 'critical-zh.json'))) {
    fs.writeFileSync(path.join(CACHE_DIR, 'critical-zh.json'), JSON.stringify(zhFlat, null, 2));
  }

  console.log(`Critical keys: ${Object.keys(enFlat).length} (not ${581})`);

  const langs = only ? [only] : TARGETS;
  for (const lang of langs) {
    console.log(`\n== ${lang} ==`);
    const flat = await buildCriticalFlat(enFlat, lang, zhFlat);
    const cm = unflatten(Object.fromEntries(
      Object.entries(flat).filter(([k]) => !k.startsWith('settings.')),
    ));
    const fp = path.join(LANG_DIR, `${lang}.ts`);
    let raw = fs.readFileSync(fp, 'utf8');
    if (raw.split('\n').length <= 15) {
      raw = injectMinified(raw, cm);
      raw = patchSettings(raw, flat);
      fs.writeFileSync(fp, raw, 'utf8');
      console.log(`[minified] ${lang}.ts`);
    } else {
      patchFormatted(lang, cm, flat);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
