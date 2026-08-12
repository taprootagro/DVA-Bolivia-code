# 数据库迁移（PostgreSQL）

| 文件 | 说明 |
|------|------|
| **[001_init.sql](001_init.sql)** | **唯一**完整建库脚本：表、RLS、种子 `app_config`、聊天相关表与 Storage（**chat-media** + **cms-public**）、`user_profiles`（含 **`content_role`**（`none` / `editor` / `admin`）、遗留 `content_super_admin`、`app_role`、`display_name` / `phone` / `pickup_address` / `avatar_url` / `profile_completed`、**`last_profile_post_at`（POST /profile 限流）** 等）与 `fn_is_content_super_admin`（`SECURITY DEFINER`，供 Storage 读管理员标志）、`push_subscriptions`（Web Push + FCM）、聊天链路成本优化、24h 云端保留、**AI 防刷**（§3a 按人限流 + §3a-bis 全站 `ai_queue_lease` 并发槽位）、**CMS CDN 孤儿清理**（`purge_cms_public_unreferenced_older_than` 识别 `/media/` 与相对路径）、**merchant_farmer_channels Realtime publication** 等。在 Supabase **SQL Editor** 中**只执行本文件**即可。空库 / 重复执行（升级旧库含修复该函数）均可（见文件头注释）。 |

**历史迁移已全部并入 001**：原 `002_fn_is_content_super_admin_security_definer.sql`、`content_role_migration.sql`、`002_chat_cost_optimizations.sql` / `003_chat_24h_retention.sql` / **AI 防刷**、`002_cms_media_cdn.sql`、`merchant_farmer_channels` 日绑定配额索引与 Realtime publication，以及 **`cms-public` 与内容管理员列**、`user_profiles` 展示资料拆列、**`002_profile_post_rate_limit.sql`（`last_profile_post_at`）** 均在 `001_init.sql` 内。**请勿再单独执行其他 `.sql` 迁移文件。**

**`app_config` 种子与 `taprootagrosetting/` 对齐**：修改默认 JSON 后执行 `node scripts/generate-seed-sql.mjs --write-init`，会更新本目录下 `001_init.sql` 内 `INSERT INTO app_config` 块（PostgreSQL 美元引用包裹 JSON，避免转义问题）。

**Edge Functions（Deno）不在此目录**：请使用上一级目录中的 **[../deploy-functions.sh](../deploy-functions.sh)** 在本机部署到 Supabase。详见 [../README.md](../README.md) 与 [../../farmer-developer/DEPLOY_GUIDE_CN.md](../../farmer-developer/DEPLOY_GUIDE_CN.md)。
