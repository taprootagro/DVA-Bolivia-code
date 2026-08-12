#!/usr/bin/env node
/**
 * Extract ct() strings from CMS components → cms-messages.en.json + patch en.ts.
 * Rewrites ct(zh, en) → ct("messages.<slug>", zh, en) in source files.
 *
 * Run: node scripts/extract-cms-strings.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const CMS_FILES = [
  'src/app/components/ConfigManagerPage.tsx',
  'src/app/components/ConfigManagerGate.tsx',
  'src/app/components/RichTextEditor.tsx',
  'src/app/components/CmsStorageUploadRow.tsx',
  'src/app/components/BackgroundSync.tsx',
];

function slugify(en) {
  let base = en
    .replace(/\{[^}]+\}/g, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8)
    .join('_');
  base = (base || 'msg').slice(0, 64);
  if (!/^[a-zA-Z_]/.test(base)) base = `m_${base}`;
  return base.replace(/[^a-zA-Z0-9_]/g, '_');
}

/** Parse ct args from inside parentheses (handles nested parens in strings poorly — skip those). */
function extractCtCalls(source) {
  const results = [];
  const re = /\bct\s*\(/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    const start = m.index + m[0].length;
    let i = start;
    let depth = 1;
    const args = [];
    let current = '';
    let inStr = null;
    let escape = false;
    while (i < source.length && depth > 0) {
      const ch = source[i];
      if (inStr) {
        current += ch;
        if (escape) escape = false;
        else if (ch === '\\') escape = true;
        else if (ch === inStr) inStr = null;
        i++;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        inStr = ch;
        current += ch;
        i++;
        continue;
      }
      if (ch === '(') {
        depth++;
        current += ch;
        i++;
        continue;
      }
      if (ch === ')') {
        depth--;
        if (depth === 0) {
          if (current.trim()) args.push(current.trim());
          break;
        }
        current += ch;
        i++;
        continue;
      }
      if (ch === ',' && depth === 1) {
        args.push(current.trim());
        current = '';
        i++;
        continue;
      }
      current += ch;
      i++;
    }
    if (args.length >= 2) {
      const parseStr = (s) => {
        const t = s.trim();
        if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
          return t.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\'/g, "'");
        }
        return null;
      };
      if (args.length >= 3) {
        const k = parseStr(args[0]);
        const zh = parseStr(args[1]);
        const en = parseStr(args[2]);
        if (k && zh != null && en != null) {
          results.push({ index: m.index, end: i + 1, key: k, zh, en, raw: source.slice(m.index, i + 1) });
        }
      } else {
        const zh = parseStr(args[0]);
        const en = parseStr(args[1]);
        if (zh != null && en != null) {
          results.push({ index: m.index, end: i + 1, key: null, zh, en, raw: source.slice(m.index, i + 1) });
        }
      }
    }
    re.lastIndex = i;
  }
  return results;
}

function escapeTs(s) {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');
}

function assignKeys(entries) {
  const used = new Map();
  const keyed = [];
  for (const e of entries) {
    let key = e.key;
    if (key && key.startsWith('messages.')) key = key.slice('messages.'.length);
    else if (key && !key.includes('.')) {
      /* dotted nav key like buttons.edit — keep as-is in messages? Plan uses messages.* only for free text */
      keyed.push({ ...e, msgKey: key.includes('.') ? null : key, nestedKey: key.includes('.') ? key : null });
      continue;
    } else if (key) {
      keyed.push({ ...e, msgKey: key.replace(/^messages\./, ''), nestedKey: null });
      continue;
    }
    let slug = slugify(e.en);
    let n = used.get(slug) || 0;
    if (n > 0) slug = `${slug}_${n}`;
    used.set(slugify(e.en), (used.get(slugify(e.en)) || 0) + 1);
    keyed.push({ ...e, msgKey: slug, nestedKey: null });
  }
  return keyed;
}

function rewriteFile(relPath, allMessages) {
  const fp = path.join(ROOT, relPath);
  let src = fs.readFileSync(fp, 'utf8');
  const calls = extractCtCalls(src).sort((a, b) => b.index - a.index);
  let changed = 0;
  for (const c of calls) {
    let msgKey = c.msgKey;
    if (!msgKey && c.key) {
      if (c.key.startsWith('messages.')) msgKey = c.key.slice('messages.'.length);
      else if (!c.key.includes('.')) msgKey = c.key;
    }
    if (!msgKey) msgKey = slugify(c.en);
    const entry = allMessages.get(`${c.zh}|||${c.en}`) || { msgKey, zh: c.zh, en: c.en };
    allMessages.set(`${c.zh}|||${c.en}`, entry);

    const nested = c.key && c.key.includes('.') && !c.key.startsWith('messages.');
    const keyArg = nested ? c.key : `messages.${entry.msgKey}`;
    const replacement = `ct("${keyArg}", "${c.zh.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}", "${c.en.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}")`;
    src = src.slice(0, c.index) + replacement + src.slice(c.end);
    changed++;
  }
  fs.writeFileSync(fp, src, 'utf8');
  console.log(`[rewrite] ${relPath}: ${changed} ct calls`);
}

// --- main ---
const allMessages = new Map();

for (const rel of CMS_FILES) {
  const fp = path.join(ROOT, rel);
  const calls = extractCtCalls(fs.readFileSync(fp, 'utf8'));
  for (const c of calls) {
    const k = `${c.zh}|||${c.en}`;
    if (!allMessages.has(k)) {
      let msgKey = null;
      if (c.key?.startsWith('messages.')) msgKey = c.key.slice('messages.'.length);
      else if (c.key && !c.key.includes('.')) msgKey = c.key;
      else msgKey = slugify(c.en);
      allMessages.set(k, { msgKey, zh: c.zh, en: c.en, nestedKey: c.key?.includes('.') ? c.key : null });
    }
  }
}

// Dedupe slugs
const slugUsed = new Map();
for (const [, v] of allMessages) {
  if (v.nestedKey) continue;
  let s = v.msgKey || slugify(v.en);
  const n = slugUsed.get(s) || 0;
  if (n > 0) s = `${s}_${n}`;
  slugUsed.set(v.msgKey || slugify(v.en), (slugUsed.get(v.msgKey || slugify(v.en)) || 0) + 1);
  v.msgKey = s;
}

const messagesObj = {};
for (const [, v] of allMessages) {
  if (v.nestedKey) continue;
  messagesObj[v.msgKey] = v.en;
}

const outJson = path.join(ROOT, 'src/app/i18n/cms-messages.en.json');
fs.writeFileSync(outJson, JSON.stringify(messagesObj, null, 2) + '\n', 'utf8');
console.log(`[write] ${outJson} (${Object.keys(messagesObj).length} keys)`);

// Patch en.ts
const enPath = path.join(ROOT, 'src/app/i18n/lang/en.ts');
let enSrc = fs.readFileSync(enPath, 'utf8');
const messagesBlock = Object.entries(messagesObj)
  .map(([k, v]) => `      ${k}: '${escapeTs(v)}',`)
  .join('\n');

if (enSrc.includes('messages: {')) {
  enSrc = enSrc.replace(/messages:\s*\{[\s\S]*?\n    \},/, `messages: {\n${messagesBlock}\n    },`);
} else {
  enSrc = enSrc.replace(
    /(pushNotification:\s*\{[\s\S]*?\n    \},)\n  \},/,
    `$1\n    messages: {\n${messagesBlock}\n    },\n  },`,
  );
}
fs.writeFileSync(enPath, enSrc, 'utf8');
console.log('[patch] en.ts configManager.messages');

// Rewrite components (re-parse with keys)
for (const rel of CMS_FILES) {
  const fp = path.join(ROOT, rel);
  let src = fs.readFileSync(fp, 'utf8');
  const calls = extractCtCalls(src).sort((a, b) => b.index - a.index);
  for (const c of calls) {
    const k = `${c.zh}|||${c.en}`;
    const entry = allMessages.get(k);
    const nested = c.key && c.key.includes('.') && !c.key.startsWith('messages.');
    const keyArg = nested ? c.key : `messages.${entry?.msgKey || slugify(c.en)}`;
    const zhEsc = c.zh.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const enEsc = c.en.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const replacement = `ct("${keyArg}", "${zhEsc}", "${enEsc}")`;
    src = src.slice(0, c.index) + replacement + src.slice(c.end);
  }
  fs.writeFileSync(fp, src, 'utf8');
  console.log(`[rewrite] ${rel}: ${calls.length} calls`);
}

// zh messages from zh strings
const zhMessages = {};
for (const [, v] of allMessages) {
  if (v.nestedKey) continue;
  zhMessages[v.msgKey] = v.zh;
}
fs.writeFileSync(
  path.join(ROOT, 'src/app/i18n/cms-messages.zh.json'),
  JSON.stringify(zhMessages, null, 2) + '\n',
  'utf8',
);
console.log(`[write] cms-messages.zh.json (${Object.keys(zhMessages).length} keys)`);
