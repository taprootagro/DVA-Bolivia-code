#!/usr/bin/env node
/**
 * Translation Extraction Script
 * 
 * Reads useLanguage.tsx and extracts each non-English language block
 * into a separate file in /src/app/i18n/lang/<code>.ts
 * 
 * Run: node src/app/i18n/extract-langs.mjs
 * 
 * After running, you can delete this script.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const LANG_DIR = join(__dirname, 'lang');
const USE_LANGUAGE_PATH = join(__dirname, '..', 'hooks', 'useLanguage.tsx');

// All non-English language codes
const LANG_CODES = [
  'zh', 'zh-TW', 'es', 'fr', 'ar', 'pt', 'hi', 'ru', 'bn', 'ur',
  'id', 'vi', 'ms', 'ja', 'th', 'my', 'tl', 'tr', 'fa'
];

function main() {
  const source = readFileSync(USE_LANGUAGE_PATH, 'utf-8');
  const lines = source.split('\n');

  // Find the translationsData block
  const dataStartIdx = lines.findIndex(l => l.includes('const translationsData'));
  if (dataStartIdx === -1) {
    console.error('Could not find translationsData in useLanguage.tsx');
    process.exit(1);
  }

  // Ensure lang dir exists
  if (!existsSync(LANG_DIR)) {
    mkdirSync(LANG_DIR, { recursive: true });
  }

  for (const code of LANG_CODES) {
    // Skip if already extracted (file exists and has content)
    const outPath = join(LANG_DIR, `${code}.ts`);
    if (existsSync(outPath)) {
      const existing = readFileSync(outPath, 'utf-8');
      if (existing.length > 100) {
        console.log(`[skip] ${code}.ts already exists`);
        continue;
      }
    }

    // Find the language block
    const langKey = code.includes('-') ? `'${code}'` : code;
    const pattern = new RegExp(`^  ${langKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*\\{`);
    
    let startLine = -1;
    for (let i = dataStartIdx; i < lines.length; i++) {
      if (pattern.test(lines[i])) {
        startLine = i;
        break;
      }
    }

    if (startLine === -1) {
      console.warn(`[warn] Could not find block for "${code}"`);
      continue;
    }

    // Find the end of this language block by tracking brace depth
    let depth = 0;
    let endLine = -1;
    for (let i = startLine; i < lines.length; i++) {
      for (const ch of lines[i]) {
        if (ch === '{') depth++;
        if (ch === '}') depth--;
      }
      if (depth === 0) {
        endLine = i;
        break;
      }
    }

    if (endLine === -1) {
      console.warn(`[warn] Could not find end of block for "${code}"`);
      continue;
    }

    // Extract the content (the object literal, minus the outer key)
    // Line at startLine looks like: `  zh: {`
    // We want everything from `{` to the matching `}`
    const blockLines = lines.slice(startLine, endLine + 1);
    
    // Remove the language key prefix from first line
    blockLines[0] = blockLines[0].replace(pattern, '{');
    
    // Remove trailing comma from last line if present
    const lastLine = blockLines[blockLines.length - 1];
    blockLines[blockLines.length - 1] = lastLine.replace(/,\s*$/, '');

    // Dedent by 2 spaces (since they were nested inside translationsData)
    const dedented = blockLines.map(l => l.startsWith('  ') ? l.slice(2) : l);

    const fileContent = [
      "import type { Translations } from '../../hooks/useLanguage';",
      '',
      `const translations: Translations = ${dedented.join('\n')};`,
      '',
      'export default translations;',
      ''
    ].join('\n');

    writeFileSync(outPath, fileContent, 'utf-8');
    console.log(`[done] ${code}.ts (${blockLines.length} lines)`);
  }

  console.log('\nExtraction complete!');
  console.log('Next steps:');
  console.log('1. Verify the generated files in /src/app/i18n/lang/');
  console.log('2. Remove the non-English blocks from useLanguage.tsx translationsData');
  console.log('3. Delete this script: rm src/app/i18n/extract-langs.mjs');
}

main();
