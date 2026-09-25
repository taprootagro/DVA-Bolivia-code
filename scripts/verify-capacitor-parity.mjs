#!/usr/bin/env node
/**
 * verify-capacitor-parity.mjs
 * Compares loadPlugin() keys in capacitor-bridge.ts with Android Builder loader template.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bridgePath = resolve(root, 'src/app/utils/capacitor-bridge.ts');
const builderPaths = [
  resolve(root, 'farmer-developer/TaprootAgro Android Builder.yml'),
  resolve(root, 'farmer-developer/Fast Android Builder.yml'),
];

const OPTIONAL_PLUGINS = new Set([
  '@capacitor-community/wechat',
  '@capacitor-community/alipay',
  '@capacitor-community/line-login',
  'capacitor-plugin-jpush',
  // Omitted from Android Builder for Google Play compliance (edge-to-edge / large screen)
  '@capacitor/status-bar',
  '@capgo/capacitor-navigation-bar',
  '@capacitor/screen-orientation',
]);

function extractBridgePlugins(src) {
  const keys = new Set();
  const re = /loadPlugin\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    keys.add(m[1]);
  }
  return keys;
}

function extractBuilderPlugins(src) {
  const keys = new Set();
  const importRe = /import \* as \w+ from '([^']+)';/g;
  let m;
  while ((m = importRe.exec(src)) !== null) {
    if (m[1].startsWith('@capacitor') || m[1].startsWith('capacitor-plugin')) {
      keys.add(m[1]);
    }
  }
  const regRe = /'(@capacitor[^']+|capacitor-plugin-[^']+)':/g;
  while ((m = regRe.exec(src)) !== null) {
    keys.add(m[1]);
  }
  return keys;
}

const bridgeSrc = readFileSync(bridgePath, 'utf8');
const bridgePlugins = extractBridgePlugins(bridgeSrc);

let failed = false;
const builderPluginsUnion = new Set();

for (const builderPath of builderPaths) {
  if (!existsSync(builderPath)) {
    console.error('Builder workflow not found:', builderPath);
    process.exit(1);
  }
  const builderSrc = readFileSync(builderPath, 'utf8');
  for (const k of extractBuilderPlugins(builderSrc)) builderPluginsUnion.add(k);
}

const missingInBuilder = [...bridgePlugins].filter(
  (k) => !builderPluginsUnion.has(k) && !OPTIONAL_PLUGINS.has(k),
);
const extraInBuilder = [...builderPluginsUnion].filter((k) => !bridgePlugins.has(k));

if (missingInBuilder.length) {
  failed = true;
  console.error('Bridge references plugins not in Android Builder loader:');
  for (const k of missingInBuilder.sort()) console.error('  -', k);
}

if (extraInBuilder.length) {
  console.warn('Builder registers plugins not referenced in bridge (informational):');
  for (const k of extraInBuilder.sort()) console.warn('  -', k);
}

const optionalUsed = [...bridgePlugins].filter((k) => OPTIONAL_PLUGINS.has(k));
if (optionalUsed.length) {
  console.warn('Optional plugins referenced in bridge (require Builder input or manual install):');
  for (const k of optionalUsed.sort()) console.warn('  -', k);
}

if (failed) {
  process.exit(1);
}

console.log(`Capacitor parity OK — ${bridgePlugins.size} bridge plugins, ${builderPluginsUnion.size} in Builder template(s).`);
