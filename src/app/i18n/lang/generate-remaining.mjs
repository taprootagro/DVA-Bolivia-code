#!/usr/bin/env node
/**
 * Quick generator for remaining language files.
 * Reads the useLanguage.tsx and extracts language blocks.
 * 
 * Run: node src/app/i18n/lang/generate-remaining.mjs
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const USE_LANGUAGE_PATH = join(__dirname, '..', '..', 'hooks', 'useLanguage.tsx');

const REMAINING = ['ru','bn','ur','id','vi','zh-TW','ms','ja','th','my','tl','tr','fa'];

const source = readFileSync(USE_LANGUAGE_PATH, 'utf-8');
const lines = source.split('\n');
const dataStartIdx = lines.findIndex(l => l.includes('const translationsData'));

for (const code of REMAINING) {
  const outPath = join(__dirname, `${code}.ts`);
  if (existsSync(outPath) && readFileSync(outPath,'utf-8').length > 200) {
    console.log(`[skip] ${code}.ts`);
    continue;
  }
  
  const langKey = code.includes('-') ? `'${code}'` : code;
  const pattern = new RegExp(`^  ${langKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*\\{`);
  
  let startLine = -1;
  for (let i = dataStartIdx; i < lines.length; i++) {
    if (pattern.test(lines[i])) { startLine = i; break; }
  }
  if (startLine === -1) { console.warn(`[warn] ${code} not found`); continue; }
  
  let depth = 0, endLine = -1;
  for (let i = startLine; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') depth++;
      if (ch === '}') depth--;
    }
    if (depth === 0) { endLine = i; break; }
  }
  if (endLine === -1) { console.warn(`[warn] ${code} end not found`); continue; }
  
  const blockLines = lines.slice(startLine, endLine + 1);
  blockLines[0] = blockLines[0].replace(pattern, '{');
  blockLines[blockLines.length - 1] = blockLines[blockLines.length - 1].replace(/,\s*$/, '');
  const dedented = blockLines.map(l => l.startsWith('  ') ? l.slice(2) : l);
  
  const content = [
    "import type { Translations } from '../../hooks/useLanguage';",
    '',
    `const translations: Translations = ${dedented.join('\n')};`,
    '',
    'export default translations;',
    ''
  ].join('\n');
  
  writeFileSync(outPath, content, 'utf-8');
  console.log(`[done] ${code}.ts (${blockLines.length} lines)`);
}
console.log('Done! Now remove inline blocks from useLanguage.tsx.');
