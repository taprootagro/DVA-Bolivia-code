#!/usr/bin/env node
/** Fix message keys that are invalid TS identifiers (prefix m_). */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function validKey(k) {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k);
}

function fixKey(k) {
  if (validKey(k)) return k;
  let f = k.replace(/[^a-zA-Z0-9_]/g, '_');
  if (!/^[a-zA-Z_]/.test(f)) f = `m_${f}`;
  return f;
}

function remapFile(obj) {
  const map = {};
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const nk = fixKey(k);
    if (out[nk] && out[nk] !== v) console.warn('[dup]', k, '->', nk);
    map[k] = nk;
    out[nk] = v;
  }
  return { out, map };
}

const enJsonPath = path.join(ROOT, 'src/app/i18n/cms-messages.en.json');
const zhJsonPath = path.join(ROOT, 'src/app/i18n/cms-messages.zh.json');
const enObj = JSON.parse(fs.readFileSync(enJsonPath, 'utf8'));
const zhObj = JSON.parse(fs.readFileSync(zhJsonPath, 'utf8'));

const { out: enOut, map } = remapFile(enObj);
const zhOut = {};
for (const [k, v] of Object.entries(zhObj)) {
  zhOut[map[k] || fixKey(k)] = v;
}

fs.writeFileSync(enJsonPath, JSON.stringify(enOut, null, 2) + '\n');
fs.writeFileSync(zhJsonPath, JSON.stringify(zhOut, null, 2) + '\n');

const changed = Object.entries(map).filter(([a, b]) => a !== b);
console.log(`[remap] ${changed.length} keys renamed`);

function escapeTs(s) {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

const messagesBlock = Object.entries(enOut)
  .map(([k, v]) => `      ${k}: '${escapeTs(v)}',`)
  .join('\n');

const enPath = path.join(ROOT, 'src/app/i18n/lang/en.ts');
let enSrc = fs.readFileSync(enPath, 'utf8');
enSrc = enSrc.replace(/messages:\s*\{[\s\S]*?\n    \},/, `messages: {\n${messagesBlock}\n    },`);
fs.writeFileSync(enPath, enSrc, 'utf8');
console.log('[patch] en.ts');

const files = [
  'src/app/components/ConfigManagerPage.tsx',
  'src/app/components/ConfigManagerGate.tsx',
  'src/app/components/RichTextEditor.tsx',
  'src/app/components/CmsStorageUploadRow.tsx',
  'src/app/components/BackgroundSync.tsx',
];

for (const rel of files) {
  let src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  for (const [oldK, newK] of changed) {
    src = src.split(`messages.${oldK}`).join(`messages.${newK}`);
  }
  fs.writeFileSync(path.join(ROOT, rel), src, 'utf8');
}
console.log('[patch] components');
