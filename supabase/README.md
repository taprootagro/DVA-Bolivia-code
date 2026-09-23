# Supabase 目录说明

本目录与 **TaprootAgro PWA** 的云端后端（PostgreSQL + Edge Functions）对应。

| 路径 | 作用 |
|------|------|
| **[migrations/001_init.sql](migrations/001_init.sql)** | **数据库一键脚本**（含 `push_subscriptions`、聊天表、`merchant_farmer_channels` 日绑定配额索引等）：在 Supabase Dashboard → **SQL Editor** 粘贴全文并执行。 |
| **[config.toml](config.toml)** | 各 Edge Function 的 **`index.tsx`** 入口与 `verify_jwt`；CLI 默认查找 `index.ts`，本仓库需此文件才能正确打包真实源码。 |
| **[deploy-functions.sh](deploy-functions.sh)** | **Edge Functions 一键部署**：在本机已 `supabase login`（或 `npx supabase login`）后执行；传入 **Project Reference ID**，将 `functions/` 下全部函数推到该项目（**`--no-verify-jwt`** 仅用于 **`server`**；**`ai-vision-proxy`**、**`chat-supabase`**、**`merchant-bind-resolve`**、**`merchant-bind-qr-url`** 不传）。不依赖 `supabase link` 与本机 Docker。 |

二者关系：**SQL 只管数据库里的表与函数（PL/pgSQL）**；**Deno 编写的 Edge Functions 必须用 CLI 或 CI 单独上传**，不能塞进 SQL 文件。详见 [../farmer-developer/DEPLOY_GUIDE_CN.md](../farmer-developer/DEPLOY_GUIDE_CN.md) 第四节。

**登录**：农户 PWA 默认在浏览器内用 **`@supabase/supabase-js`** 调 Supabase Auth（OTP / OAuth PKCE，见 `src/app/utils/supabaseBrowser.ts`）。`server` Edge 上的 `/send-code`、`/auth`、`/oauth-exchange` 为**遗留兼容**，不必作为新部署的登录主路径。

**Capacitor 壳**：打成 App 时请在 Supabase **Redirect URLs** 里**额外**加入 WebView 的 **`{origin}/auth/callback`**（如 `capacitor://localhost/auth/callback` 等），与网站 URL **并列**；见 [../farmer-developer/DEPLOY_GUIDE_CN.md](../farmer-developer/DEPLOY_GUIDE_CN.md) §7。

**示例（在仓库根目录）：**

```bash
./supabase/deploy-functions.sh abcdefghijklmnop
```

多租户 / 批量部署说明见 [../farmer-developer/DEPLOY_GUIDE_CN.md](../farmer-developer/DEPLOY_GUIDE_CN.md) §4.3.1。
