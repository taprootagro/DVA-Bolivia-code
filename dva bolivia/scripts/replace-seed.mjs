import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sqlPath = path.join(__dirname, '..', 'supabase', 'migrations', '001_init.sql');
const newSeedPath = path.join(__dirname, '..', '.tmp-seed.sql');

const sql = fs.readFileSync(sqlPath, 'utf8');
const newSeedBlock = fs.readFileSync(newSeedPath, 'utf8').trim();

// Find section boundaries
const section8Start = sql.indexOf('-- 8. 种子数据');
const section8HeaderEnd = sql.indexOf('\nINSERT INTO app_config', section8Start);
const section9Start = sql.indexOf('-- 9. 种子历史记录', section8HeaderEnd);

if (section8Start === -1 || section9Start === -1) {
  console.error('Could not find section boundaries in SQL file');
  process.exit(1);
}

// Extract prefix (before INSERT) and suffix (after ON CONFLICT)
const prefix = sql.slice(0, section8HeaderEnd) + '\n\n';
const suffix = '\n\n' + sql.slice(section9Start);

// Build the new SQL
const newSql = prefix + newSeedBlock + suffix;

// Backup old file
const backupPath = sqlPath + '.bak';
fs.writeFileSync(backupPath, sql, 'utf8');
console.log('Backup saved to', backupPath);

// Write the updated SQL
fs.writeFileSync(sqlPath, newSql, 'utf8');
console.log('Updated 001_init.sql with new seed data');
console.log('Prefix length:', prefix.length);
console.log('New seed length:', newSeedBlock.length);
console.log('Suffix length:', suffix.length);
