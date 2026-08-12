#!/usr/bin/env node
/**
 * 以内容管理器配置为准构建 dist：
 * 1. 优先 cms-export.json（浏览器 localStorage 导出）
 * 2. 否则用 taprootagrosetting（dev 下「保存到本机」已写回）
 * 3. 同步 001_init.sql 种子
 * 4. vite build
 *
 * 从浏览器导出 CMS（DevTools Console）：
 *   copy(localStorage.getItem('agri_home_config'))
 *   粘贴保存为项目根 cms-export.json
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const cmsExport = path.join(root, 'cms-export.json');

function run(cmd, args, label) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(`[build-from-cms] failed: ${label}`);
    process.exit(r.status ?? 1);
  }
}

if (fs.existsSync(cmsExport)) {
  console.log('[build-from-cms] using cms-export.json');
  run(process.execPath, ['scripts/apply-config-to-settings.mjs', cmsExport], 'apply-config-to-settings');
} else {
  console.log('[build-from-cms] cms-export.json not found — using taprootagrosetting/*.json');
}

run(process.execPath, ['scripts/generate-seed-sql.mjs', '--write-init'], 'generate-seed-sql');
run(process.execPath, ['node_modules/vite/bin/vite.js', 'build'], 'vite build');

console.log('[build-from-cms] done — dist/ reflects Content Manager settings');
