#!/usr/bin/env node
/**
 * CI / 本地一键：用环境变量覆盖 taprootagrosetting 中的 Supabase URL 与 anon key，
 * 便于「每客户独立 Supabase」时在 npm run build 前注入，再打出仅连该后端的 dist。
 *
 * 用法（GitHub Actions Secrets → 环境变量）：
 *   CUSTOMER_SUPABASE_URL=https://xxxx.supabase.co
 *   CUSTOMER_SUPABASE_ANON_KEY=eyJ...  （或 sb_publishable_...）
 *   CUSTOMER_REMOTE_CONFIG_URL=https://customer.example.com/config.json  （可选）
 *   node scripts/apply-customer-backend-to-settings.mjs
 *
 * 若 CUSTOMER_SUPABASE_URL / CUSTOMER_SUPABASE_ANON_KEY 任一未设置，脚本直接退出 0（不写文件）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const backendPath = path.join(root, "taprootagrosetting", "backend.json");
const aiPath = path.join(root, "taprootagrosetting", "ai.json");

const url = (process.env.CUSTOMER_SUPABASE_URL || "").trim().replace(/\/+$/, "");
const anon = (process.env.CUSTOMER_SUPABASE_ANON_KEY || "").trim();
const remoteConfigUrl = (process.env.CUSTOMER_REMOTE_CONFIG_URL || process.env.VITE_REMOTE_CONFIG_URL || "").trim();

if (!url || !anon) {
  console.log("[apply-customer-backend] skip: CUSTOMER_SUPABASE_URL / CUSTOMER_SUPABASE_ANON_KEY not both set");
  process.exit(0);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    console.error("[apply-customer-backend] read failed:", filePath, e);
    process.exit(1);
  }
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

const backend = readJson(backendPath);
backend.backendProxyConfig = backend.backendProxyConfig || {};
backend.backendProxyConfig.supabaseUrl = url;
backend.backendProxyConfig.supabaseAnonKey = anon;
backend.backendProxyConfig.enabled = true;
writeJson(backendPath, backend);
console.log("[apply-customer-backend] updated", backendPath, "→", url);

const ai = readJson(aiPath);
ai.cloudAIConfig = ai.cloudAIConfig || {};
ai.cloudAIConfig.supabaseUrl = url;
ai.cloudAIConfig.supabaseAnonKey = anon;
writeJson(aiPath, ai);
console.log("[apply-customer-backend] updated", aiPath, "→", url);

if (remoteConfigUrl) {
  console.log("[apply-customer-backend] CUSTOMER_REMOTE_CONFIG_URL =", remoteConfigUrl);
  console.log("[apply-customer-backend] pass to build: VITE_REMOTE_CONFIG_URL=" + remoteConfigUrl);
}
