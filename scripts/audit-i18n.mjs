#!/usr/bin/env node
/** Audit critical CMS i18n only (~100 visible keys). */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, 'src/app/i18n/.cache');
const LANG_DIR = path.join(ROOT, 'src/app/i18n/lang');

const LANGS = [
  'zh', 'zh-TW', 'es', 'fr', 'ar', 'pt', 'hi', 'ru', 'bn', 'ur',
  'id', 'vi', 'ms', 'ja', 'th', 'my', 'tl', 'tr', 'fa',
];

const WHITELIST = new Set([
  'TaprootAgro', 'Supabase', 'FCM', 'JPush', 'Push', 'Splash', 'Desc',
  'AI Config', 'IM Backend', 'AI Model', 'PWA', 'ID', 'Channel ID',
]);

function isWhitelisted(v) {
  if (!v || v.length <= 3) return true;
  if (WHITELIST.has(v)) return true;
  if (/^[🌐🔥⚡]/.test(v)) return true;
  return false;
}

function hasSettingsKey(raw, key) {
  return raw.includes(`"${key}"`) || raw.includes(`${key}:`);
}

function countOrphanCt() {
  const files = [
    'src/app/components/ConfigManagerPage.tsx',
    'src/app/components/ConfigManagerGate.tsx',
  ];
  let n = 0;
  const re = /\bct\(\s*"([^"]*)"\s*,\s*"([^"]*)"\s*\)/g;
  for (const rel of files) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    while (re.exec(src)) n++;
  }
  return n;
}

const enPath = path.join(CACHE, 'critical-en.json');
if (!fs.existsSync(enPath)) {
  console.error('Run: node scripts/apply-cms-i18n-critical.mjs first');
  process.exit(1);
}
const enFlat = JSON.parse(fs.readFileSync(enPath, 'utf8'));
const enKeys = Object.keys(enFlat).filter((k) => !k.startsWith('settings.'));

console.log('=== CMS critical i18n audit ===\n');
console.log(`Critical keys: ${enKeys.length}`);

let exitCode = 0;
const only = process.argv.includes('--lang')
  ? process.argv[process.argv.indexOf('--lang') + 1]
  : null;

for (const lang of only ? [only] : LANGS) {
  const cachePath = path.join(CACHE, `critical-${lang}.json`);
  const fp = path.join(LANG_DIR, `${lang}.ts`);
  const raw = fs.readFileSync(fp, 'utf8');
  if (!fs.existsSync(cachePath)) {
    console.log(`${lang}: missing critical cache — run apply-cms-i18n-critical.mjs`);
    exitCode = 1;
    continue;
  }
  const flat = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  const missing = enKeys.filter((k) => !(k in flat));
  const same = enKeys.filter((k) => flat[k] === enFlat[k] && !isWhitelisted(flat[k]));
  const issues = [];
  if (missing.length) issues.push(`${missing.length} missing`);
  if (same.length > 5) issues.push(`${same.length} still English`);
  if (!hasSettingsKey(raw, 'technicalSupportDesc')) issues.push('no technicalSupportDesc');
  if (!hasSettingsKey(raw, 'technicalSupportText')) issues.push('no technicalSupportText');
  if (issues.length) {
    console.log(`${lang}: ${issues.join(', ')}`);
    if (same.length) same.slice(0, 3).forEach((k) => console.log(`  ${k}: ${flat[k]}`));
    if (same.length > 5) exitCode = 1;
  } else {
    console.log(`${lang}: OK`);
  }
}

console.log(`\nOrphan 2-arg ct(): ${countOrphanCt()}`);
process.exit(exitCode);
