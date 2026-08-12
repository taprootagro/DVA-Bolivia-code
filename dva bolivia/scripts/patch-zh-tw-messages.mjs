#!/usr/bin/env node
/** Copy messages block from zh.ts into zh-TW.ts (same keys; TW UI already uses 繁體 elsewhere). */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const LANG = path.join(ROOT, 'src/app/i18n/lang');

function extractMessages(raw) {
  const m = raw.match(/messages:\s*\{([\s\S]*?)\n      \},/);
  if (!m) return null;
  const out = {};
  const re = /(\w+):\s*'((?:\\'|[^'])*)'/g;
  let r;
  while ((r = re.exec(m[1]))) {
    out[r[1]] = r[2].replace(/\\'/g, "'").replace(/\\n/g, '\n');
  }
  return out;
}

const zhRaw = fs.readFileSync(path.join(LANG, 'zh.ts'), 'utf8');
const twRaw = fs.readFileSync(path.join(LANG, 'zh-TW.ts'), 'utf8');
const zhMsg = extractMessages(zhRaw);
if (!zhMsg) throw new Error('zh messages not found');

const msgLines = Object.entries(zhMsg)
  .map(([k, v]) => `        ${k}: '${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}',`)
  .join('\n');

let out = twRaw;
if (out.includes('messages: {')) {
  out = out.replace(/messages:\s*\{[\s\S]*?\n      \},/, `messages: {\n${msgLines}\n      },`);
} else {
  out = out.replace(
    /(pushNotification:\s*\{[\s\S]*?\n      \},)\n    \},/,
    `$1\n      messages: {\n${msgLines}\n      },\n    },`,
  );
}
fs.writeFileSync(path.join(LANG, 'zh-TW.ts'), out, 'utf8');
console.log(`[done] zh-TW messages: ${Object.keys(zhMsg).length} keys`);
