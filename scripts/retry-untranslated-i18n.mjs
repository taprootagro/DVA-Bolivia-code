#!/usr/bin/env node
/** Re-translate flat cache keys that still match English. */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, 'src/app/i18n/.cache');

const MM = {
  'zh-TW': 'zh-TW', th: 'th', vi: 'vi', ja: 'ja', fr: 'fr', es: 'es', ar: 'ar',
  pt: 'pt', hi: 'hi', ru: 'ru', bn: 'bn', ur: 'ur', id: 'id', ms: 'ms', my: 'my',
  tl: 'tl', tr: 'tr', fa: 'fa',
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function translateText(text, lang) {
  const tl = MM[lang] || lang;
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text.slice(0, 480))}&langpair=en|${encodeURIComponent(tl)}`;
  const res = await fetch(url);
  const data = await res.json();
  return data.responseData?.translatedText || text;
}

const langs = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(MM);
const enFlat = JSON.parse(fs.readFileSync(path.join(CACHE, 'flat-en.json'), 'utf8'));

for (const lang of langs) {
  const fp = path.join(CACHE, `flat-${lang}.json`);
  if (!fs.existsSync(fp)) continue;
  const flat = JSON.parse(fs.readFileSync(fp, 'utf8'));
  const stale = Object.keys(enFlat).filter(
    (k) => !k.startsWith('settings.') && flat[k] === enFlat[k] && enFlat[k].length > 4,
  );
  if (!stale.length) {
    console.log(`${lang}: nothing to fix`);
    continue;
  }
  console.log(`${lang}: retry ${stale.length} keys`);
  for (const k of stale) {
    await sleep(200);
    flat[k] = await translateText(enFlat[k], lang);
  }
  fs.writeFileSync(fp, JSON.stringify(flat, null, 2));
}

console.log('Done. Re-run: node scripts/apply-cms-i18n-all-langs.mjs');
