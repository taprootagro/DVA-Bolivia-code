-- ============================================================================
-- TaprootAgro PWA — Supabase 唯一完整库表/种子脚本（supabase/migrations/001_init.sql）
-- ============================================================================
--
-- 使用方法：
--   1. 打开 Supabase Dashboard → SQL Editor
--   2. 粘贴本文件全部内容
--   3. 点击 Run — 完成！（仅此一个 SQL 文件；空库 / 重复执行均可；含旧 merchant_bind_tokens 补列兼容）
--
-- 本脚本创建（已合并原独立 002* 片段，含：fn_is_content_super_admin 为 SECURITY DEFINER ——
--   重复跑本文件可让旧库从 INVOKER 升级，修复 cms-public 上传；以及 002_chat_cost_optimizations
--   + 003_chat_24h_retention + AI 防刷表/函数 + 002_cms_media_cdn（CMS 孤儿清理识别 CDN/相对路径）
--   + merchant_farmer_channels 日绑定配额统计索引 idx_merchant_farmer_channels_*_created
--   + merchant_farmer_channels 加入 supabase_realtime publication（门店 subscribeStorePeerInserts）
--   + user_profiles 展示资料拆列 display_name / phone / pickup_address / avatar_url / profile_completed
--   + user_profiles.content_role 枚举 none|editor|admin（原 content_role_migration.sql 已并入）：
--   ✅ 12 张表 (app_config, config_history, user_profiles, regional_oauth_identities,
--               merchant_bind_tokens [legacy], chat_messages, chat_rl_upload_sign,
--               merchant_bind_rl, push_subscriptions, merchant_farmer_channels, farmer_merchant_bindings, ai_usage)
--   ✅ Storage 桶 chat-media（聊天媒体公开读）、cms-public（CMS 媒体公开读，仅内容管理员写；
--      §10c：pg_cron 按 app_config+config_history 引用清理 cms-public 孤儿对象，默认 24h）
--   ✅ RLS 策略 (所有表锁定为 service_role，前端无法直接访问)
--   ✅ 3 个触发器 (自动版本递增、自动更新时间戳、自动历史快照)
--   ✅ 辅助函数 (含 fn_is_content_super_admin、Dashboard 管理 app_config 等)
--   ✅ Supabase 聊天保留：purge_chat_messages_older_than / purge_chat_media_storage_older_than
--      —— pg_cron 每小时清理 chat_messages + chat-media（云端仅 24h，手机本地 IndexedDB 长期保留）
--   ✅ 聊天成本优化：chat_messages 移出 supabase_realtime publication；
--      realtime.messages 加 RLS（仅 chat:<channel_id> 的参与者可订阅 broadcast）
--   ✅ 种子数据 (完整的出厂默认配置)
--   ✅ 索引 (优化查询性能)
--
-- 架构设计：
--   ┌─────────────────────────────────────────────────────────┐
--   │  你在 Dashboard 中编辑 app_config.config (JSONB)        │
--   │          ↓ 触发器自动执行                                │
--   │  1. version 自动 +1                                     │
--   │  2. updated_at 自动更新                                 │
--   │  3. 旧版本自动写入 config_history                        │
--   │          ↓                                              │
--   │  用户打开 APP / 切回前台                                 │
--   │          ↓                                              │
--   │  GET /server/config → 发现 version 变大 → 更新客户端    │
--   └─────────────────────────────────────────────────────────┘
--
-- 安全模型：
--   - 所有表启用 RLS，策略锁定为 service_role
--   - 前端 anonKey 无法直接读写任何表
--   - 所有数据访问通过 Edge Function (service_role) 中转
--   - Dashboard 编辑使用 postgres 角色，不受 RLS 限制
--
-- ============================================================================


-- ============================================================================
-- 0. 清理旧版本（如果存在）— 幂等执行
-- ============================================================================
-- 如果你重复运行本脚本，先删除旧的触发器和函数避免冲突。
-- 表使用 IF NOT EXISTS，不会丢数据。
-- 注：空库无 app_config 时不能 DROP TRIGGER … ON app_config（会 42P01），故仅表存在时清理。

DO $drop_app_config_triggers$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'app_config' AND c.relkind = 'r'
  ) THEN
    DROP TRIGGER IF EXISTS trg_app_config_auto_version ON public.app_config;
    DROP TRIGGER IF EXISTS trg_app_config_auto_history ON public.app_config;
  END IF;
END
$drop_app_config_triggers$;

DROP FUNCTION IF EXISTS fn_app_config_auto_version();
DROP FUNCTION IF EXISTS fn_app_config_auto_history();
DROP FUNCTION IF EXISTS update_config_section(TEXT, JSONB, TEXT);
DROP FUNCTION IF EXISTS get_config_section(TEXT);
DROP FUNCTION IF EXISTS rollback_config(INTEGER, TEXT);
DROP FUNCTION IF EXISTS get_config_overview();
DROP FUNCTION IF EXISTS search_config(TEXT);


-- ============================================================================
-- 1. app_config — 远程配置存储（单行 JSONB）
-- ============================================================================
-- 核心表：整个 APP 的配置存在一行 JSONB 中。
-- 你在 Dashboard 的 Table Editor 里点击 config 列即可编辑。
--
-- 列说明：
--   id          — 固定为 'main'，保证单行
--   config      — 完整配置 JSONB（文章、商品、品牌、直播等所有内容）
--   version     — 版本号（触发器自动递增，用于客户端判断是否有更新）
--   updated_at  — 最后修改时间（触发器自动更新）
--   updated_by  — 谁修改的（可选，手动填写或 Edge Function 自动填）

CREATE TABLE IF NOT EXISTS app_config (
  id          TEXT PRIMARY KEY DEFAULT 'main',
  config      JSONB NOT NULL DEFAULT '{}',
  version     INTEGER NOT NULL DEFAULT 1,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  TEXT
);

ALTER TABLE app_config ENABLE ROW LEVEL SECURITY;

-- RLS: 只允许 service_role（Edge Function 用 service_role 调用，绕过 RLS）
-- Dashboard 用 postgres 角色编辑，也不受 RLS 限制
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'app_config' AND policyname = 'app_config_service_role_only'
  ) THEN
    CREATE POLICY "app_config_service_role_only"
      ON app_config FOR ALL
      USING (auth.role() = 'service_role')
      WITH CHECK (auth.role() = 'service_role');
  END IF;
END $$;


-- ============================================================================
-- 2. config_history — 配置版本历史（自动快照）
-- ============================================================================
-- 每次 app_config 被修改，触发器自动将旧版本插入这里。
-- 用于：查看历史变更、回滚到任意版本。
--
-- 列说明：
--   id          — 自增主键
--   config      — 该版本的完整配置快照
--   version     — 对应的版本号
--   created_at  — 快照创建时间
--   created_by  — 谁触发的修改
--   note        — 备注（如 "Dashboard 编辑"、"回滚到 v3"）

CREATE TABLE IF NOT EXISTS config_history (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  config      JSONB NOT NULL,
  version     INTEGER NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  TEXT,
  note        TEXT
);

ALTER TABLE config_history ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'config_history' AND policyname = 'config_history_service_role_only'
  ) THEN
    CREATE POLICY "config_history_service_role_only"
      ON config_history FOR ALL
      USING (auth.role() = 'service_role')
      WITH CHECK (auth.role() = 'service_role');
  END IF;
END $$;


-- ============================================================================
-- 3. user_profiles — 用户资料存储
-- ============================================================================

CREATE TABLE IF NOT EXISTS user_profiles (
  user_id         UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  profile         JSONB NOT NULL DEFAULT '{}',
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_ai_call    TIMESTAMPTZ,
  ai_calls_today  INT NOT NULL DEFAULT 0,
  ai_calls_day    DATE
);

-- 旧库仅含 profile/updated_at 时幂等补列
ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS last_ai_call TIMESTAMPTZ;
ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS ai_calls_today INT NOT NULL DEFAULT 0;
ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS ai_calls_day DATE;

ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS content_super_admin BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN user_profiles.last_ai_call   IS 'ai-vision-proxy 最近一次成功调用时间，用于 INTERVAL 限流';
COMMENT ON COLUMN user_profiles.ai_calls_today IS '当天 ai-vision-proxy 成功调用次数（跨日自动清零）';
COMMENT ON COLUMN user_profiles.ai_calls_day   IS '上次计数对应的本地日期，用于跨日检测';
COMMENT ON COLUMN public.user_profiles.content_super_admin IS
  'Legacy: prefer content_role. When true, treated as admin for backward compat. Set only in SQL/Dashboard.';

-- content_role：内容管理权限（none | editor | admin）；原 content_role_migration.sql 已并入本文件
DO $$ BEGIN
  CREATE TYPE public.user_content_role AS ENUM ('none', 'editor', 'admin');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS content_role public.user_content_role NOT NULL DEFAULT 'none'::public.user_content_role;

COMMENT ON COLUMN public.user_profiles.content_role IS
  'CMS access: none | editor (content tabs) | admin (full incl. server settings & role assign). SQL/Dashboard only.';

UPDATE public.user_profiles
SET content_role = 'admin'::public.user_content_role
WHERE content_super_admin = true;

GRANT USAGE ON TYPE public.user_content_role TO anon, authenticated, service_role;

-- app_role：PostgreSQL ENUM，Supabase Table Editor 中显示为下拉选项（farmer | distributor）
DO $$ BEGIN
  CREATE TYPE public.user_app_role AS ENUM ('farmer', 'distributor');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS app_role public.user_app_role NOT NULL DEFAULT 'farmer'::public.user_app_role;

-- 已从旧版 TEXT + CHECK 建库的：升级为 ENUM（去掉 CHECK，与 Dashboard 下拉一致）
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.table_name = 'user_profiles'
      AND c.column_name = 'app_role'
      AND c.data_type = 'text'
  ) THEN
    ALTER TABLE public.user_profiles DROP CONSTRAINT IF EXISTS user_profiles_app_role_check;
    ALTER TABLE public.user_profiles
      ALTER COLUMN app_role DROP DEFAULT,
      ALTER COLUMN app_role TYPE public.user_app_role USING app_role::public.user_app_role,
      ALTER COLUMN app_role SET DEFAULT 'farmer'::public.user_app_role,
      ALTER COLUMN app_role SET NOT NULL;
  END IF;
END $$;

COMMENT ON COLUMN public.user_profiles.app_role IS
  'Community UI: farmer = 1:1 chat shell, distributor = store multi-chat shell. Enum user_app_role. Set in SQL/Dashboard; not client-writable via profile JSON.';

GRANT USAGE ON TYPE public.user_app_role TO anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- user_profiles：展示资料拆列（昵称 / 手机 / 提货地址 ≤200 字符 / 头像 / 是否完善）
-- 幂等：ADD COLUMN IF NOT EXISTS；回填仅当 profile JSON 有值时写入空列
-- ---------------------------------------------------------------------------
ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS display_name TEXT NOT NULL DEFAULT '';

ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS phone TEXT NOT NULL DEFAULT '';

ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS pickup_address VARCHAR(200) NOT NULL DEFAULT '';

ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS avatar_url TEXT NOT NULL DEFAULT '';

ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS profile_completed BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.user_profiles.display_name IS '展示昵称；与 profile JSON 的 name 脱钩后以本列为准';
COMMENT ON COLUMN public.user_profiles.phone IS '用户填写或 OTP 手机；与 profile JSON 脱钩后以本列为准';
COMMENT ON COLUMN public.user_profiles.pickup_address IS '提货点/地址，最多 200 字符';
COMMENT ON COLUMN public.user_profiles.avatar_url IS '头像 URL 或 data:image base64；宜控制体积';
COMMENT ON COLUMN public.user_profiles.profile_completed IS '四项（昵称/手机/提货地址/头像）均非空则为 true';

-- ---------------------------------------------------------------------------
-- POST /profile 服务端限流时间戳（原独立文件 002_profile_post_rate_limit.sql 已并入）
-- 与 Edge Secret PROFILE_POST_MIN_INTERVAL_SECONDS（默认 300）配合；可重复执行。
-- ---------------------------------------------------------------------------
ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS last_profile_post_at TIMESTAMPTZ;

COMMENT ON COLUMN public.user_profiles.last_profile_post_at IS
  '最近一次用户通过 POST /profile 成功写入的时间；用于 profile_completed 已为 true 时的最小间隔限流';

UPDATE public.user_profiles up
SET
  display_name = COALESCE(NULLIF(btrim(up.profile->>'name'), ''), up.display_name),
  phone = COALESCE(NULLIF(btrim(up.profile->>'phone'), ''), up.phone),
  avatar_url = COALESCE(NULLIF(btrim(up.profile->>'avatar'), ''), up.avatar_url),
  pickup_address = COALESCE(
    NULLIF(left(btrim(COALESCE(up.profile->>'pickup_address', up.profile->>'pickupAddress', '')), 200), ''),
    up.pickup_address
  )
WHERE up.profile IS NOT NULL;

UPDATE public.user_profiles
SET profile_completed = (
  btrim(display_name) <> ''
  AND btrim(phone) <> ''
  AND btrim(pickup_address) <> ''
  AND btrim(avatar_url) <> ''
);

ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'user_profiles' AND policyname = 'user_profiles_service_role_only'
  ) THEN
    CREATE POLICY "user_profiles_service_role_only"
      ON user_profiles FOR ALL
      USING (auth.role() = 'service_role')
      WITH CHECK (auth.role() = 'service_role');
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- user_profiles：内容管理员标志的 RLS 辅助函数（Supabase Storage cms-public 策略用）
-- content_role / content_super_admin 仅允许 SQL/Dashboard 修改，勿写入 profile JSONB。
--
-- SECURITY DEFINER：user_profiles 的 RLS 为「仅 service_role 可访」，以 authenticated
-- 调用者身份无法 SELECT 本表；而 Storage 策略在评估时必须让「当前 JWT 用户」能读到
-- 自己的管理员标志。故用 DEFINER 以函数所有者权限读表；auth.uid() 仍为
-- 当前请求的 JWT 用户，不会扩大为查他人数据。
-- search_path 固定，避免可注入对象名劫持。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_is_content_super_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT up.content_role = 'admin'::public.user_content_role
            OR up.content_super_admin
     FROM public.user_profiles up
     WHERE up.user_id = auth.uid()),
    false
  );
$$;

REVOKE ALL ON FUNCTION public.fn_is_content_super_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_is_content_super_admin() TO authenticated;

COMMENT ON FUNCTION public.fn_is_content_super_admin() IS
  'For Storage RLS: true when content_role=admin or legacy content_super_admin for auth.uid(). SECURITY DEFINER required because user_profiles is service_role-only.';


-- ============================================================================
-- 3a. AI Proxy 服务端防刷 — ai_usage + RPC + pg_cron（Edge ai-vision-proxy / enforceRateLimit）
-- ============================================================================
-- 滑动窗口由 ai_usage 计数；INTERVAL+DAILY 由 ai_rate_limit_check 原子更新 user_profiles。
-- 与 farmer-developer/DEPLOY_GUIDE_CN.md §5.4、config.toml verify_jwt 配套。

CREATE TABLE IF NOT EXISTS ai_usage (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  route      TEXT,
  provider   TEXT,
  ip         TEXT
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_user_created
  ON ai_usage (user_id, created_at DESC);

ALTER TABLE ai_usage ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'ai_usage' AND policyname = 'ai_usage_service_role_only'
  ) THEN
    CREATE POLICY "ai_usage_service_role_only"
      ON ai_usage FOR ALL
      USING (auth.role() = 'service_role')
      WITH CHECK (auth.role() = 'service_role');
  END IF;
END $$;

-- 返回值：'OK' | 'INTERVAL' | 'DAILY'（WINDOW 由 Edge COUNT ai_usage）
CREATE OR REPLACE FUNCTION public.ai_rate_limit_check(
  p_user_id         UUID,
  p_interval_sec    INT DEFAULT 10,
  p_daily_limit     INT DEFAULT 30
)
RETURNS TABLE (
  status               TEXT,
  retry_after_seconds  INT,
  daily_remaining      INT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r_last  TIMESTAMPTZ;
  r_today INT;
  r_day   DATE;
  today   DATE := (now() AT TIME ZONE 'UTC')::DATE;
  dt_sec  INT;
BEGIN
  INSERT INTO user_profiles (user_id)
  VALUES (p_user_id)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT last_ai_call, ai_calls_today, ai_calls_day
    INTO r_last, r_today, r_day
    FROM user_profiles
   WHERE user_id = p_user_id
   FOR UPDATE;

  IF r_last IS NOT NULL THEN
    dt_sec := GREATEST(0, p_interval_sec - CAST(EXTRACT(EPOCH FROM (now() - r_last)) AS INT));
    IF dt_sec > 0 THEN
      status := 'INTERVAL';
      retry_after_seconds := dt_sec;
      daily_remaining := GREATEST(0, p_daily_limit - COALESCE(r_today, 0));
      RETURN NEXT;
      RETURN;
    END IF;
  END IF;

  IF r_day IS DISTINCT FROM today THEN
    r_today := 0;
  END IF;

  IF COALESCE(r_today, 0) >= p_daily_limit THEN
    status := 'DAILY';
    retry_after_seconds := NULL;
    daily_remaining := 0;
    RETURN NEXT;
    RETURN;
  END IF;

  UPDATE user_profiles
     SET last_ai_call   = now(),
         ai_calls_today = COALESCE(r_today, 0) + 1,
         ai_calls_day   = today
   WHERE user_id = p_user_id;

  status := 'OK';
  retry_after_seconds := NULL;
  daily_remaining := GREATEST(0, p_daily_limit - (COALESCE(r_today, 0) + 1));
  RETURN NEXT;
END
$$;

REVOKE ALL ON FUNCTION public.ai_rate_limit_check(UUID, INT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ai_rate_limit_check(UUID, INT, INT) TO service_role;

CREATE OR REPLACE FUNCTION public.purge_ai_usage_older_than(p_days INT DEFAULT 7)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n INT;
BEGIN
  DELETE FROM ai_usage
   WHERE created_at < now() - (p_days || ' days')::INTERVAL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;

REVOKE ALL ON FUNCTION public.purge_ai_usage_older_than(INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.purge_ai_usage_older_than(INT) TO service_role;
GRANT EXECUTE ON FUNCTION public.purge_ai_usage_older_than(INT) TO postgres;

DO $reschedule_ai_usage_purge$
DECLARE
  r RECORD;
  has_cron BOOLEAN;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') INTO has_cron;
  IF NOT has_cron THEN
    RAISE NOTICE
      'pg_cron not installed — skip ai_usage purge schedule. '
      'Enable it in Dashboard → Database → Extensions and re-run this migration.';
    RETURN;
  END IF;

  FOR r IN
    SELECT jobid, jobname FROM cron.job
    WHERE jobname IN ('purge-ai-usage-7d')
  LOOP
    PERFORM cron.unschedule(r.jobid);
    RAISE NOTICE 'unscheduled cron job %', r.jobname;
  END LOOP;

  PERFORM cron.schedule(
    'purge-ai-usage-7d',
    '17 3 * * *',
    'SELECT public.purge_ai_usage_older_than(7);'
  );
  RAISE NOTICE 'scheduled purge-ai-usage-7d (daily @ 03:17, retention=7d)';
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'pg_cron schedule failed (%); you can DELETE FROM ai_usage manually', SQLERRM;
END
$reschedule_ai_usage_purge$;


-- ============================================================================
-- 3a-bis. AI 全站并发闸门 — ai_queue_lease + RPC（Edge ai-vision-proxy 取/还槽位）
-- ============================================================================
-- 限制全站同时 in-flight 的云端 AI 请求数（semaphore）；满员返回 QUEUE，由客户端重试。
-- 非 FIFO 任务表；无服务端存放等候图片。acquire 前清理过期 lease，不依赖 pg_cron。

CREATE TABLE IF NOT EXISTS ai_queue_lease (
  lease_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  route       TEXT,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_queue_lease_expires
  ON ai_queue_lease (expires_at);

ALTER TABLE ai_queue_lease ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'ai_queue_lease' AND policyname = 'ai_queue_lease_service_role_only'
  ) THEN
    CREATE POLICY "ai_queue_lease_service_role_only"
      ON ai_queue_lease FOR ALL
      USING (auth.role() = 'service_role')
      WITH CHECK (auth.role() = 'service_role');
  END IF;
END $$;

-- 返回值：'OK' | 'QUEUE'
CREATE OR REPLACE FUNCTION public.ai_queue_try_acquire(
  p_max         INT,
  p_lease_sec   INT,
  p_user_id     UUID DEFAULT NULL,
  p_route       TEXT DEFAULT NULL
)
RETURNS TABLE (
  status               TEXT,
  lease_id             UUID,
  retry_after_seconds  INT,
  queue_depth          INT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_active INT;
  v_lease  UUID;
  v_max    INT;
  v_sec    INT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('ai_queue_lease'));

  v_max := GREATEST(5, LEAST(100, COALESCE(p_max, 100)));
  v_sec := GREATEST(30, LEAST(300, COALESCE(p_lease_sec, 120)));

  DELETE FROM ai_queue_lease WHERE expires_at <= now();

  SELECT COUNT(*)::INT INTO v_active FROM ai_queue_lease WHERE expires_at > now();

  IF v_active < v_max THEN
    INSERT INTO ai_queue_lease (user_id, route, expires_at)
    VALUES (p_user_id, NULLIF(TRIM(p_route), ''), now() + (v_sec || ' seconds')::INTERVAL)
    RETURNING ai_queue_lease.lease_id INTO v_lease;

    status := 'OK';
    lease_id := v_lease;
    retry_after_seconds := NULL;
    queue_depth := NULL;
    RETURN NEXT;
    RETURN;
  END IF;

  status := 'QUEUE';
  lease_id := NULL;
  retry_after_seconds := 6 + floor(random() * 4)::INT;
  queue_depth := GREATEST(1, v_active - v_max + 1);
  RETURN NEXT;
END
$$;

REVOKE ALL ON FUNCTION public.ai_queue_try_acquire(INT, INT, UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ai_queue_try_acquire(INT, INT, UUID, TEXT) TO service_role;

CREATE OR REPLACE FUNCTION public.ai_queue_release(p_lease_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_lease_id IS NULL THEN
    RETURN;
  END IF;
  DELETE FROM ai_queue_lease WHERE lease_id = p_lease_id;
END
$$;

REVOKE ALL ON FUNCTION public.ai_queue_release(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ai_queue_release(UUID) TO service_role;


-- ============================================================================
-- 3b. regional_oauth_identities — 微信 / 支付宝 / LINE 等「非 Supabase 内置 OAuth」主体与 Auth 用户映射
-- ============================================================================
-- Edge `server` 的 POST /wechat/exchange、POST /alipay/exchange、POST /line/exchange 使用：用厂商 code 换 openid/user_id 后
-- 查表绑定或新建 auth.users；login_email 为该用户在 Supabase Auth 中的邮箱（随机、仅服务端换票使用）。

CREATE TABLE IF NOT EXISTS regional_oauth_identities (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider     TEXT NOT NULL CHECK (provider IN ('wechat', 'alipay', 'line')),
  subject      TEXT NOT NULL,
  login_email  TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, subject)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_regional_oauth_login_email
  ON regional_oauth_identities (login_email);

ALTER TABLE regional_oauth_identities ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'regional_oauth_identities' AND policyname = 'regional_oauth_identities_service_role_only'
  ) THEN
    CREATE POLICY "regional_oauth_identities_service_role_only"
      ON regional_oauth_identities FOR ALL
      USING (auth.role() = 'service_role')
      WITH CHECK (auth.role() = 'service_role');
  END IF;
END $$;


-- ============================================================================
-- 4. 索引
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_user_profiles_updated
  ON user_profiles (updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_config_history_version
  ON config_history (version DESC);

CREATE INDEX IF NOT EXISTS idx_config_history_created
  ON config_history (created_at DESC);


-- ============================================================================
-- 5. 触发器 — 自动版本递增 + 自动时间戳
-- ============================================================================
-- 核心机制：你在 Dashboard 改了 config 列的内容 → 触发器自动：
--   1. version + 1
--   2. updated_at = now()
-- 这样客户端下次拉取时发现 version 变大，就会用新内容。

CREATE OR REPLACE FUNCTION fn_app_config_auto_version()
RETURNS TRIGGER AS $$
BEGIN
  -- 只在 config 列实际发生变化时递增版本
  IF OLD.config IS DISTINCT FROM NEW.config THEN
    NEW.version := OLD.version + 1;
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_app_config_auto_version
  BEFORE UPDATE ON app_config
  FOR EACH ROW
  EXECUTE FUNCTION fn_app_config_auto_version();


-- ============================================================================
-- 6. 触发器 — 自动历史快照
-- ============================================================================
-- 每次 config 被修改，自动将【修改前的旧版本】保存到 config_history。
-- 这样你永远可以回滚到任何一个历史版本。

CREATE OR REPLACE FUNCTION fn_app_config_auto_history()
RETURNS TRIGGER AS $$
BEGIN
  -- 只在 config 列实际发生变化时写历史
  IF OLD.config IS DISTINCT FROM NEW.config THEN
    INSERT INTO config_history (config, version, created_by, note)
    VALUES (
      OLD.config,
      OLD.version,
      COALESCE(NEW.updated_by, 'dashboard'),
      'Auto-snapshot before v' || NEW.version
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_app_config_auto_history
  AFTER UPDATE ON app_config
  FOR EACH ROW
  EXECUTE FUNCTION fn_app_config_auto_history();


-- ============================================================================
-- 7. 辅助函数 — 在 Dashboard SQL Editor 中管理内容
-- ============================================================================

-- -------------------------------------------------------
-- 7a. update_config_section — 更新配置的某个区块
-- -------------------------------------------------------
-- 用法示例（在 SQL Editor 中运行）：
--
--   -- 更新文章列表：
--   SELECT update_config_section('articles', '[
--     {"id":1,"title":"新文章标题","author":"作者","views":"999","category":"种植","date":"今天","content":"文章内容..."}
--   ]'::jsonb);
--
--   -- 更新品牌信息：
--   SELECT update_config_section('appBranding', '{
--     "logoUrl": "https://...",
--     "appName": "MyFarm",
--     "slogan": "Smart farming"
--   }'::jsonb);
--
--   -- 更新货币符号：
--   SELECT update_config_section('currencySymbol', '"$"'::jsonb);
--

CREATE OR REPLACE FUNCTION update_config_section(
  section_key TEXT,
  section_value JSONB,
  editor_name TEXT DEFAULT 'dashboard'
)
RETURNS TABLE(new_version INTEGER, updated_at TIMESTAMPTZ) AS $$
BEGIN
  UPDATE app_config
  SET
    config = jsonb_set(config, ARRAY[section_key], section_value),
    updated_by = editor_name
  WHERE id = 'main';

  RETURN QUERY
    SELECT ac.version, ac.updated_at
    FROM app_config ac
    WHERE ac.id = 'main';
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION update_config_section IS
'更新配置中的某个区块。触发器会自动递增 version 并保存历史快照。
用法: SELECT update_config_section(''articles'', ''[...]''::jsonb);';


-- -------------------------------------------------------
-- 7b. get_config_section — 读取配置的某个区块
-- -------------------------------------------------------
-- 用法：
--   SELECT get_config_section('articles');
--   SELECT get_config_section('appBranding');
--   SELECT get_config_section('liveStreams');
--

CREATE OR REPLACE FUNCTION get_config_section(section_key TEXT)
RETURNS JSONB AS $$
  SELECT config -> section_key FROM app_config WHERE id = 'main';
$$ LANGUAGE sql;

COMMENT ON FUNCTION get_config_section IS
'读取配置中某个区块的 JSON。用法: SELECT get_config_section(''articles'');';


-- -------------------------------------------------------
-- 7c. rollback_config — 回滚到历史版本
-- -------------------------------------------------------
-- 用法：
--   -- 先查看历史版本列表：
--   SELECT version, created_at, note FROM config_history ORDER BY version DESC LIMIT 20;
--
--   -- 回滚到版本 3：
--   SELECT rollback_config(3);
--

CREATE OR REPLACE FUNCTION rollback_config(
  target_version INTEGER,
  editor_name TEXT DEFAULT 'dashboard-rollback'
)
RETURNS TABLE(new_version INTEGER, rolled_back_to INTEGER) AS $$
DECLARE
  snapshot_config JSONB;
BEGIN
  -- 查找目标版本的快照
  SELECT ch.config INTO snapshot_config
  FROM config_history ch
  WHERE ch.version = target_version
  ORDER BY ch.created_at DESC
  LIMIT 1;

  IF snapshot_config IS NULL THEN
    RAISE EXCEPTION 'Version % not found in config_history', target_version;
  END IF;

  -- 写回 app_config（触发器会自动递增 version 并保存当前版本到历史）
  UPDATE app_config
  SET
    config = snapshot_config,
    updated_by = editor_name
  WHERE id = 'main';

  RETURN QUERY
    SELECT ac.version, target_version
    FROM app_config ac
    WHERE ac.id = 'main';
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION rollback_config IS
'回滚到历史版本。当前版本会自动保存到 config_history。
用法: SELECT rollback_config(3);';


-- -------------------------------------------------------
-- 7d. get_config_overview — 查看配置概览
-- -------------------------------------------------------
-- 快速查看每个配置区块有多少条目。
-- 用法：SELECT * FROM get_config_overview();
--

CREATE OR REPLACE FUNCTION get_config_overview()
RETURNS TABLE(
  section TEXT,
  item_count TEXT,
  preview TEXT
) AS $$
DECLARE
  cfg JSONB;
BEGIN
  SELECT config INTO cfg FROM app_config WHERE id = 'main';

  RETURN QUERY
  SELECT
    k.key::TEXT AS section,
    CASE
      WHEN jsonb_typeof(k.value) = 'array' THEN jsonb_array_length(k.value)::TEXT || ' items'
      WHEN jsonb_typeof(k.value) = 'object' THEN (SELECT count(*)::TEXT || ' keys' FROM jsonb_object_keys(k.value) AS _)
      ELSE jsonb_typeof(k.value)
    END AS item_count,
    left(k.value::TEXT, 80) AS preview
  FROM jsonb_each(cfg) AS k(key, value)
  ORDER BY k.key;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION get_config_overview IS
'查看配置概览：每个区块的类型和条目数。用法: SELECT * FROM get_config_overview();';


-- -------------------------------------------------------
-- 7e. search_config — 全文搜索配置内容
-- -------------------------------------------------------
-- 在配置 JSON 中搜索关键词（不区分大小写）。
-- 用法：SELECT * FROM search_config('小麦');
--

CREATE OR REPLACE FUNCTION search_config(keyword TEXT)
RETURNS TABLE(
  section TEXT,
  matched_content TEXT
) AS $$
DECLARE
  cfg JSONB;
BEGIN
  SELECT config INTO cfg FROM app_config WHERE id = 'main';

  RETURN QUERY
  SELECT
    k.key::TEXT AS section,
    left(k.value::TEXT, 200) AS matched_content
  FROM jsonb_each(cfg) AS k(key, value)
  WHERE k.value::TEXT ILIKE '%' || keyword || '%'
  ORDER BY k.key;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION search_config IS
'在配置中搜索关键词。用法: SELECT * FROM search_config(''小麦'');';


-- ============================================================================
-- 8. 种子数据 — 出厂默认配置
-- ============================================================================
-- 插入完整的出厂配置。如果行已存在则不覆盖（ON CONFLICT DO NOTHING）。
-- 如果你想重置为出厂配置，先 DELETE FROM app_config; 再重新运行本段。



INSERT INTO app_config (id, config, version, updated_by)
VALUES (
  'main',
  $taproot_app_config_seed$
{
      "banners": [
            {
                  "id": 1,
                  "alt": "demo",
                  "url": "https://cdn.topagro.com/demo/photo-1.jpeg",
                  "title": "demo",
                  "content": "<p>article demo</p><p></p><p>探索现代农业的无限可能，从智能种植到精准管理，TaprootAgro引领农业革命。</p><p></p><p>Explore the boundless possibilities of modern agriculture—from smart cultivation to precision management—as TaprootAgro leads the agricultural revolution.</p>"
            },
            {
                  "id": 2,
                  "alt": "demo",
                  "url": "https://cdn.topagro.com/demo/photo-3.jpeg",
                  "title": "demo",
                  "content": "<p>article demo</p><p></p><p>见证丰收的喜悦，TaprootAgro提供全面的农业解决方案，帮助您实现丰收。</p><p></p><p>Witness the joy of a bountiful harvest—TaprootAgro provides comprehensive agricultural solutions to help you achieve a successful yield.</p>"
            },
            {
                  "id": 3,
                  "alt": "demo",
                  "url": "https://cdn.topagro.com/demo/photo-2.jpeg",
                  "title": "demo",
                  "content": "<p>article demo</p><p></p><p>拥抱绿色生态，TaprootAgro致力于可持续农业发展，提供环保的种植方案。</p><p></p><p>Embracing a green ecosystem, TaprootAgro is dedicated to the development of sustainable agriculture, providing eco-friendly cultivation solutions.</p>"
            }
      ],
      "navigation": [
            {
                  "id": 1,
                  "icon": "ScanLine",
                  "title": "病虫识别",
                  "subtitle": "AI智能检测"
            },
            {
                  "id": 2,
                  "icon": "Bot",
                  "title": "AI助手",
                  "subtitle": "智能问答"
            },
            {
                  "id": 3,
                  "icon": "Calculator",
                  "title": "收益统计",
                  "subtitle": "数据分析"
            },
            {
                  "id": 4,
                  "icon": "MapPin",
                  "title": "农田地图",
                  "subtitle": "位置管理"
            }
      ],
      "liveStreams": [
            {
                  "id": 1,
                  "title": "New products",
                  "navWaze": false,
                  "viewers": "1234",
                  "videoUrl": "https://cdn.topagro.com/demo/demo.mp4",
                  "shareText": "DEMO",
                  "thumbnail": "https://cdn.topagro.com/demo/photo-4.jpeg",
                  "navAddress": "CBD",
                  "navAmapMap": true,
                  "navEnabled": true,
                  "shareTitle": "DEMO",
                  "navBaiduMap": false,
                  "navLatitude": "117.15",
                  "navAppleMaps": false,
                  "navCreatedAt": 1778642789165,
                  "navLongitude": "36.67",
                  "shareEnabled": true,
                  "navCoordSystem": "bd09",
                  "navDisplayDays": 90
            }
      ],
      "articles": [
            {
                  "id": 1,
                  "date": "2天前",
                  "title": "Spring is a critical period for wheat growth..",
                  "views": "1.2k",
                  "author": "农业专家",
                  "content": "<p>article demo</p><p></p><p>春季是小麦生长的关键时期...</p><p>Spring is a critical period for wheat growth...</p>",
                  "category": "种植技术",
                  "thumbnail": "https://cdn.topagro.com/demo/photo-4.jpeg"
            },
            {
                  "id": 2,
                  "date": "3天前",
                  "title": "Common diseases and pests of corn include...",
                  "views": "856",
                  "author": "植保专家",
                  "content": "<p>article demo</p><p></p><p>玉米常见病虫害包括...</p><p>Common diseases and pests of corn include...</p>",
                  "category": "病虫害",
                  "thumbnail": "https://cdn.topagro.com/demo/photo-4.jpeg"
            },
            {
                  "id": 3,
                  "date": "5天前",
                  "title": "Scientific fertilization is the key to increasing crop yields.",
                  "views": "642",
                  "author": "土壤专家",
                  "content": "<p>article demo</p><p></p><p>科学施肥是提高作物产量的关键...</p><p>Scientific fertilization is the key to increasing crop yields.</p>",
                  "category": "施肥管理",
                  "thumbnail": "https://cdn.topagro.com/demo/photo-4.jpeg"
            },
            {
                  "id": 4,
                  "date": "1周前",
                  "title": "Temperature and humidity control during the seedling-raising stage directly affects...",
                  "views": "923",
                  "author": "种植达人",
                  "content": "<p>article demo</p><p></p><p>育秧期的温湿度控制直接影响...</p><p>Temperature and humidity control during the seedling-raising stage directly affects...</p>",
                  "category": "栽培技术",
                  "thumbnail": "https://cdn.topagro.com/demo/photo-4.jpeg"
            },
            {
                  "id": 5,
                  "date": "3天前",
                  "title": "article demo",
                  "views": "1.5k",
                  "author": "设施农业专家",
                  "content": "<p>article demo</p><p></p><p>智能温室大棚通过物联网技术...</p><p>demo</p>",
                  "category": "设施农业",
                  "thumbnail": "https://cdn.topagro.com/demo/photo-4.jpeg"
            },
            {
                  "id": 6,
                  "date": "4天前",
                  "title": "article demo",
                  "views": "789",
                  "author": "灌溉专家",
                  "content": "<p>article demo</p><p></p><p>水肥一体化是现代农业的重要技术...</p><p></p>",
                  "category": "灌溉技术",
                  "thumbnail": "https://cdn.topagro.com/demo/photo-4.jpeg"
            },
            {
                  "id": 7,
                  "date": "6天前",
                  "title": "article demo",
                  "views": "1.1k",
                  "author": "果树专家",
                  "content": "<p>article demo</p><p></p><p>果树修剪是果树栽培管理的重要环节...</p><p></p>",
                  "category": "果树管理",
                  "thumbnail": "https://cdn.topagro.com/demo/photo-4.jpeg"
            }
      ],
      "videoFeed": {
            "title": "农业短视频",
            "description": "观看最新农业技术视频",
            "videoSources": []
      },
      "homeIcons": {
            "aiAssistantIconUrl": "",
            "aiAssistantLabel": "",
            "statementIconUrl": "",
            "statementLabel": "",
            "liveCoverUrl": "",
            "liveTitle": "",
            "liveBadge": ""
      },
      "currencySymbol": "¥",
      "marketPage": {
            "categories": [
                  {
                        "id": "herbicide",
                        "name": "her",
                        "_type": "category",
                        "subCategories": [
                              "demo1",
                              "demo2",
                              "demo3"
                        ]
                  },
                  {
                        "id": "insecticide",
                        "name": "ins",
                        "_type": "category",
                        "subCategories": [
                              "demo1",
                              "demo2",
                              "demo3"
                        ]
                  },
                  {
                        "id": "fungicide",
                        "name": "fun",
                        "_type": "category",
                        "subCategories": [
                              "demo1",
                              "demo2",
                              "demo3"
                        ]
                  },
                  {
                        "id": "Rice",
                        "name": "rice package",
                        "subCategories": [
                              "Pre-emergence",
                              "Post-emergence"
                        ]
                  },
                  {
                        "id": "corn",
                        "name": "corn package",
                        "subCategories": [
                              "corn package"
                        ]
                  }
            ],
            "products": [
                  {
                        "id": 1,
                        "name": "demo",
                        "image": "https://cdn.topagro.com/demo/bottle.webp",
                        "price": "¥68",
                        "stock": 100,
                        "category": "herbicide",
                        "description": "强效除草剂",
                        "subCategory": "demo1",
                        "specifications": ""
                  },
                  {
                        "id": 5,
                        "name": "demo",
                        "image": "https://cdn.topagro.com/demo/bottle.webp",
                        "price": "¥78",
                        "stock": 110,
                        "category": "insecticide",
                        "description": "接触即死，快速见效",
                        "subCategory": "demo2",
                        "specifications": ""
                  },
                  {
                        "id": 11,
                        "name": "demo",
                        "image": "https://cdn.topagro.com/demo/bottle.webp",
                        "price": "¥68",
                        "stock": 90,
                        "category": "fungicide",
                        "description": "预防病害",
                        "subCategory": "demo3",
                        "specifications": ""
                  },
                  {
                        "id": 17,
                        "name": "demo",
                        "_type": "product",
                        "image": "https://cdn.topagro.com/demo/photo-4.jpeg",
                        "price": "¥125",
                        "stock": 150,
                        "category": "fertilizer",
                        "description": "促进叶片生长",
                        "subCategory": "demo",
                        "specifications": ""
                  },
                  {
                        "id": 18,
                        "name": "demo",
                        "image": "https://cdn.topagro.com/demo/bottle.webp",
                        "price": "$100",
                        "stock": 0,
                        "category": "herbicide",
                        "videoUrl": "",
                        "description": "",
                        "subCategory": "demo1",
                        "specifications": ""
                  },
                  {
                        "id": 19,
                        "name": "demo",
                        "image": "https://cdn.topagro.com/demo/bottle.webp",
                        "price": "99",
                        "stock": 0,
                        "category": "herbicide",
                        "videoUrl": "",
                        "description": "",
                        "subCategory": "demo2",
                        "specifications": ""
                  },
                  {
                        "id": 20,
                        "name": "demo",
                        "image": "https://cdn.topagro.com/demo/bottle.webp",
                        "price": "99",
                        "stock": 0,
                        "category": "herbicide",
                        "videoUrl": "",
                        "description": "",
                        "subCategory": "demo3",
                        "specifications": ""
                  },
                  {
                        "id": 21,
                        "name": "demo",
                        "image": "https://cdn.topagro.com/demo/bottle.webp",
                        "price": "99",
                        "stock": 0,
                        "category": "herbicide",
                        "videoUrl": "",
                        "description": "",
                        "subCategory": "demo2",
                        "specifications": ""
                  },
                  {
                        "id": 22,
                        "name": "demo",
                        "image": "https://cdn.topagro.com/demo/bottle.webp",
                        "price": "99",
                        "stock": 0,
                        "category": "insecticide",
                        "videoUrl": "",
                        "description": "",
                        "subCategory": "demo2",
                        "specifications": ""
                  },
                  {
                        "id": 23,
                        "name": "demo",
                        "image": "https://cdn.topagro.com/demo/bottle.webp",
                        "price": "99",
                        "stock": 0,
                        "category": "insecticide",
                        "videoUrl": "",
                        "description": "",
                        "subCategory": "demo1",
                        "specifications": ""
                  },
                  {
                        "id": 24,
                        "name": "demo",
                        "image": "https://cdn.topagro.com/demo/bottle.webp",
                        "price": "99",
                        "stock": 0,
                        "category": "corn",
                        "videoUrl": "",
                        "description": "",
                        "subCategory": "corn package",
                        "specifications": ""
                  },
                  {
                        "id": 25,
                        "name": "demo",
                        "image": "https://cdn.topagro.com/demo/bottle.webp",
                        "price": "99",
                        "stock": 0,
                        "category": "corn",
                        "videoUrl": "",
                        "description": "",
                        "subCategory": "corn package",
                        "specifications": ""
                  },
                  {
                        "id": 26,
                        "name": "demo",
                        "image": "https://cdn.topagro.com/demo/bottle.webp",
                        "price": "99",
                        "stock": 0,
                        "category": "corn",
                        "videoUrl": "",
                        "description": "",
                        "subCategory": "corn package",
                        "specifications": ""
                  },
                  {
                        "id": 27,
                        "name": "demo",
                        "image": "https://cdn.topagro.com/demo/bottle.webp",
                        "price": "99",
                        "stock": 0,
                        "category": "Rice",
                        "videoUrl": "",
                        "description": "",
                        "subCategory": "Pre-emergence",
                        "specifications": ""
                  },
                  {
                        "id": 28,
                        "name": "demo",
                        "image": "https://cdn.topagro.com/demo/bottle.webp",
                        "price": "99",
                        "stock": 0,
                        "category": "Rice",
                        "videoUrl": "",
                        "description": "",
                        "subCategory": "Pre-emergence",
                        "specifications": ""
                  },
                  {
                        "id": 29,
                        "name": "demo",
                        "image": "https://cdn.topagro.com/demo/bottle.webp",
                        "price": "",
                        "stock": 0,
                        "category": "Rice",
                        "videoUrl": "",
                        "description": "",
                        "subCategory": "Post-emergence",
                        "specifications": ""
                  }
            ],
            "advertisements": [
                  {
                        "id": 1,
                        "image": "https://cdn.topagro.com/demo/photo-4.jpeg",
                        "title": "ads",
                        "content": "<p>TaprootAgro 2026年春季农业技术培训班正式开放报名！</p>"
                  }
            ]
      },
      "profileEditCooldownSeconds": 300,
      "appBranding": {
            "logoUrl": "https://apicdn.dva-agro.com/media/logo.png",
            "appName": "DVA Bolivia",
            "slogan": "GO FUTURE.TOGETHER"
      },
      "splashScreen": {
            "imageUrl": "https://apicdn.dva-agro.com/media/splash.png",
            "minDisplayMs": 2000,
            "maxResourceWaitMs": 4000,
            "showSkipButton": true
      },
      "desktopIcon": {
            "appName": "DVA Bolivia",
            "icon192Url": "https://apicdn.dva-agro.com/media/icon-192.png",
            "icon512Url": "https://apicdn.dva-agro.com/media/icon-512.png"
      },
      "filing": {
            "icpNumber": "",
            "icpUrl": "",
            "policeNumber": "",
            "policeUrl": ""
      },
      "communityUiMode": "store",
      "chatContact": {
            "merchantUserId": "e6dbb6c7-1117-4495-abb5-8bc0f47693c8",
            "channelId": "73221b15-b29c-40f2-92e7-53a80b782bc0",
            "name": "rick wang",
            "avatar": "https://lh3.googleusercontent.com/a/ACg8ocKed7CvoEavg1W6g_YinlrXyS9lGHQkVGDs5-6q9iJaVn8eDb4=s96-c",
            "subtitle": "",
            "verifiedDomains": [
                  "topagro.com"
            ],
            "boundAt": 1779695811990,
            "boundFrom": "topagro.com",
            "phone": "",
            "storeId": "",
            "imUserId": "",
            "imProvider": ""
      },
      "userProfile": {
            "name": "",
            "avatar": "",
            "phone": "",
            "pickupAddress": ""
      },
      "aboutUs": {
            "title": "关于我们",
            "content": "<p>我们是一家专注于农业技术的公司，致力于提供最先进的农业解决方案。</p><p></p><p>We are a company specializing in agricultural technology, dedicated to providing the most advanced agricultural solutions.</p>"
      },
      "privacyPolicy": {
            "title": "隐私政策",
            "content": "<p>我们尊重并保护所有使用我们服务的用户的隐私。</p><p></p><p>We respect and protect the privacy of all users who use our services.</p>"
      },
      "termsOfService": {
            "title": "用户协议",
            "content": "<p>欢迎使用我们的服务！</p><p>welcome</p>"
      },
      "technicalSupport": {
            "title": "技术支持",
            "content": "<p>本项目由taprootagro提供技术支持。我们提供全流程技术支持，助力您零门槛实现同款产品的快速部署与稳定运行。如有需求，欢迎联系咨询。</p><p><br></p><p>Support by taprootagro.</p><p><span>Fully open-source. We offer full-cycle technical support for barrier-free deployment and stable operation. Contact us to get started.</span></p><p><br></p><p><strong>Taprootagro Technology Limited</strong></p><p>Website:&nbsp;www.taprootagro.com</p><p>Email:&nbsp;Info@taprootagro.com</p>"
      },
      "aiModelConfig": {
            "modelUrl": "",
            "labelsUrl": "",
            "enableLocalModel": false
      },
      "cloudAIConfig": {
            "enabled": true,
            "providerName": "通义千问",
            "edgeFunctionName": "ai-vision-proxy",
            "modelId": "qwen3.7-flash",
            "systemPrompt": "",
            "maxTokens": 512,
            "clientDailyLimit": 15,
            "clientCooldownSeconds": 20,
            "clientWindowPerMin": 6,
            "supabaseUrl": "",
            "supabaseAnonKey": "",
            "allowUnauthenticatedUse": false
      },
      "pushConfig": {
            "vapidPublicKey": "BJ1YYF0-4bU8LqTd_TPHhCgpGUlrnPpnGWxG1QQIRu79Zeqs6d4uGbPlR_VZs2refsNWSNDkw2PpjKJZEyDPGLk",
            "pushApiBase": "",
            "enabled": true
      },
      "pushProvidersConfig": {
            "activeProvider": "webpush",
            "webpush": {
                  "enabled": true,
                  "vapidPublicKey": "BJ1YYF0-4bU8LqTd_TPHhCgpGUlrnPpnGWxG1QQIRu79Zeqs6d4uGbPlR_VZs2refsNWSNDkw2PpjKJZEyDPGLk",
                  "pushApiBase": ""
            },
            "fcm": {
                  "enabled": false,
                  "apiKey": "",
                  "projectId": "",
                  "appId": "",
                  "messagingSenderId": "",
                  "vapidKey": ""
            },
            "onesignal": {
                  "enabled": false,
                  "appId": "",
                  "safariWebId": ""
            },
            "jpush": {
                  "enabled": false,
                  "appKey": "",
                  "masterSecret": "",
                  "channel": "",
                  "pushApiBase": ""
            },
            "getui": {
                  "enabled": false,
                  "appId": "",
                  "appKey": "",
                  "masterSecret": "",
                  "pushApiBase": ""
            }
      },
      "loginConfig": {
            "socialProviders": {
                  "wechat": false,
                  "google": true,
                  "facebook": false,
                  "apple": false,
                  "alipay": false,
                  "twitter": false,
                  "line": false
            },
            "oauthCredentials": {
                  "wechat": {
                        "appId": ""
                  },
                  "google": {
                        "clientId": ""
                  },
                  "facebook": {
                        "appId": ""
                  },
                  "apple": {
                        "serviceId": "",
                        "teamId": "",
                        "keyId": ""
                  },
                  "alipay": {
                        "appId": ""
                  },
                  "twitter": {
                        "apiKey": ""
                  },
                  "line": {
                        "channelId": ""
                  }
            },
            "enablePhoneLogin": false,
            "enableEmailLogin": false,
            "defaultLoginMethod": "phone"
      },
      "liveShareConfig": {
            "enabled": false,
            "shareUrl": "",
            "shareTitle": "TaprootAgro直播",
            "shareText": "",
            "shareImgUrl": "",
            "wxJsSdkEnabled": false,
            "wxAppId": "",
            "wxSignatureApi": ""
      },
      "liveNavigationConfig": {
            "enabled": false,
            "latitude": "",
            "longitude": "",
            "address": "",
            "coordSystem": "wgs84",
            "baiduMap": true,
            "amapMap": true,
            "googleMap": true,
            "appleMaps": true,
            "waze": true
      },
      "backendProxyConfig": {
            "supabaseUrl": "https://api-bolivia.dva-agro.com",
            "supabaseAnonKey": "sb_publishable_QM3OAkja3MEIDunUM9vD0w_wTC7XJX0",
            "edgeFunctionName": "server",
            "enabled": true,
            "chatProvider": "supabase",
            "imMode": "im-provider-direct",
            "cmsStorageProvider": "supabase",
            "mediaCdnBaseUrl": "https://apicdn.dva-agro.com/media"
      }
}
$taproot_app_config_seed$::jsonb,
  1,
  'init-script'
)
ON CONFLICT (id) DO NOTHING;

-- 9. 种子历史记录 — 记录初始版本
-- ============================================================================

INSERT INTO config_history (config, version, created_by, note)
SELECT config, version, 'init-script', 'Initial seed configuration'
FROM app_config
WHERE id = 'main'
  AND NOT EXISTS (SELECT 1 FROM config_history WHERE version = 1);


-- ============================================================================
-- 10. 商家短链绑定 + Supabase 聊天（原 migrations/002_chat_merchant.sql）
-- ============================================================================
-- merchant_bind_tokens — 短链 token → JSON 商家信息（仅 service_role）
-- chat_messages — Realtime 订阅；anon/authenticated 只读，写入仅 Edge
-- ============================================================================

-- ---------------------------------------------------------------------------
-- merchant_bind_tokens
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS merchant_bind_tokens (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token              TEXT NOT NULL UNIQUE,
  payload            JSONB NOT NULL,
  expires_at         TIMESTAMPTZ,
  revoked            BOOLEAN NOT NULL DEFAULT false,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  merchant_user_id   TEXT,
  sequence_num       INTEGER
);

-- 旧库兼容：表已由早期脚本创建但无下列列时先补列（幂等），须在 merchant_user_id 索引之前执行
ALTER TABLE merchant_bind_tokens ADD COLUMN IF NOT EXISTS merchant_user_id TEXT;
ALTER TABLE merchant_bind_tokens ADD COLUMN IF NOT EXISTS sequence_num INTEGER;

CREATE INDEX IF NOT EXISTS idx_merchant_bind_tokens_token ON merchant_bind_tokens (token);
CREATE INDEX IF NOT EXISTS idx_merchant_bind_tokens_merchant_user
  ON merchant_bind_tokens (merchant_user_id);

ALTER TABLE merchant_bind_tokens ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS merchant_bind_tokens_service ON merchant_bind_tokens;
CREATE POLICY merchant_bind_tokens_service ON merchant_bind_tokens
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- merchant_farmer_channels（必须先于 chat_messages 的 RLS 策略创建，策略引用本表）
-- 新 QR 方案：二维码内容即 /m/<merchant_user_id>，不再依赖 merchant_bind_tokens。
-- 每 (merchant_user_id, farmer_user_id) 唯一分配一个 channel_id；双方都能 SELECT 自己的绑定行。
-- Edge merchant-bind-resolve 写入；app 侧只读。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS merchant_farmer_channels (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bind_token         TEXT,
  farmer_user_id     TEXT NOT NULL,
  channel_id         TEXT NOT NULL,
  merchant_user_id   UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 旧库兼容：表可能已由早期脚本创建但无 merchant_user_id / bind_token 为 NOT NULL 时补列 & 放宽
ALTER TABLE merchant_farmer_channels
  ADD COLUMN IF NOT EXISTS merchant_user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE merchant_farmer_channels
  ALTER COLUMN bind_token DROP NOT NULL;

-- 新的账号级唯一键（同一农户×门店至多一个 channel）
CREATE UNIQUE INDEX IF NOT EXISTS uq_merchant_farmer_channels_account
  ON merchant_farmer_channels (merchant_user_id, farmer_user_id)
  WHERE merchant_user_id IS NOT NULL;

-- channel_id 仍需全局唯一
CREATE UNIQUE INDEX IF NOT EXISTS uq_merchant_farmer_channels_channel
  ON merchant_farmer_channels (channel_id);

CREATE INDEX IF NOT EXISTS idx_merchant_farmer_channels_merchant
  ON merchant_farmer_channels (merchant_user_id);

CREATE INDEX IF NOT EXISTS idx_merchant_farmer_channels_farmer
  ON merchant_farmer_channels (farmer_user_id);

CREATE INDEX IF NOT EXISTS idx_merchant_farmer_channels_token
  ON merchant_farmer_channels (bind_token);

-- 防滥用：merchant-bind-resolve 日配额按 created_at 统计（农户/门店维度）
CREATE INDEX IF NOT EXISTS idx_merchant_farmer_channels_farmer_created
  ON merchant_farmer_channels (farmer_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_merchant_farmer_channels_merchant_created
  ON merchant_farmer_channels (merchant_user_id, created_at DESC);

ALTER TABLE merchant_farmer_channels ENABLE ROW LEVEL SECURITY;

-- Realtime postgres_changes：门店 subscribeStorePeerInserts 监听新农户绑定
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE merchant_farmer_channels;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Edge（service_role）全权读写
DROP POLICY IF EXISTS merchant_farmer_channels_service ON merchant_farmer_channels;
CREATE POLICY merchant_farmer_channels_service ON merchant_farmer_channels
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 参与者（门店或农户）可 SELECT 自己的绑定行（用于列表与 Realtime 订阅）
DROP POLICY IF EXISTS merchant_farmer_channels_select_participants ON merchant_farmer_channels;
CREATE POLICY merchant_farmer_channels_select_participants ON merchant_farmer_channels
  FOR SELECT TO authenticated
  USING (
    merchant_user_id = auth.uid()
    OR farmer_user_id = auth.uid()::text
  );

GRANT SELECT ON TABLE merchant_farmer_channels TO authenticated;

-- 门店/农户客户端：可读「已绑定会话对象」的 user_profiles（昵称/头像等），供 storeBindingRepo / farmerBindingRepo 通讯录展示。
-- 仍不可写；content_role 等敏感列同行可读（仅限绑定关系内的对端，非全网公开）。
GRANT SELECT ON TABLE public.user_profiles TO authenticated;

DROP POLICY IF EXISTS user_profiles_select_self_or_binding_peer ON public.user_profiles;
CREATE POLICY user_profiles_select_self_or_binding_peer ON public.user_profiles
  FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.merchant_farmer_channels mfc
      WHERE mfc.merchant_user_id = auth.uid()
        AND mfc.farmer_user_id = user_profiles.user_id::text
    )
    OR EXISTS (
      SELECT 1 FROM public.merchant_farmer_channels mfc
      WHERE mfc.farmer_user_id = auth.uid()::text
        AND mfc.merchant_user_id = user_profiles.user_id
    )
  );

COMMENT ON TABLE merchant_farmer_channels IS
  'Account-based channel allocation: one channel_id per (merchant_user_id, farmer_user_id). Writes via Edge merchant-bind-resolve; participants SELECT their own rows.';
COMMENT ON COLUMN merchant_farmer_channels.bind_token IS
  'LEGACY column for historical rows from merchant-bind-pool flow; new rows leave it NULL.';

-- ---------------------------------------------------------------------------
-- chat_messages
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chat_messages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id  TEXT NOT NULL,
  sender_id   TEXT NOT NULL,
  msg_type    TEXT NOT NULL CHECK (msg_type IN ('text', 'image', 'voice', 'video')),
  body        TEXT,
  media_url   TEXT,
  duration_ms INTEGER,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_channel_created
  ON chat_messages (channel_id, created_at DESC);

-- 防刷：按 sender 统计近 1 分钟 / 当日消息条数（Edge enforceChatMessageRateLimit）
CREATE INDEX IF NOT EXISTS idx_chat_messages_sender_created
  ON chat_messages (sender_id, created_at DESC);

ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;

-- 只有该 channel 对应的门店/农户可以 SELECT（需农户/门店 JWT）；匿名与其他用户一律拒绝。
-- 依赖下方 merchant_farmer_channels（account-based binding）。
DROP POLICY IF EXISTS chat_messages_select_anon ON chat_messages;
DROP POLICY IF EXISTS chat_messages_select_authenticated ON chat_messages;

DROP POLICY IF EXISTS chat_messages_select_participants ON chat_messages;
CREATE POLICY chat_messages_select_participants ON chat_messages
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM merchant_farmer_channels mfc
      WHERE mfc.channel_id = chat_messages.channel_id
        AND (
          mfc.merchant_user_id = auth.uid()
          OR mfc.farmer_user_id = auth.uid()::text
        )
    )
  );

DROP POLICY IF EXISTS chat_messages_write_service ON chat_messages;
CREATE POLICY chat_messages_write_service ON chat_messages
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE chat_messages;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- Storage: chat-media（公开读，写由 Edge service_role）
-- ---------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public)
VALUES ('chat-media', 'chat-media', true)
ON CONFLICT (id) DO UPDATE SET public = EXCLUDED.public;

DROP POLICY IF EXISTS chat_media_public_read ON storage.objects;
CREATE POLICY chat_media_public_read ON storage.objects
  FOR SELECT TO public
  USING (bucket_id = 'chat-media');

-- ---------------------------------------------------------------------------
-- Storage: cms-public（Config Manager 上传；公开读，写仅 content_super_admin）
-- ---------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public)
VALUES ('cms-public', 'cms-public', true)
ON CONFLICT (id) DO UPDATE SET public = EXCLUDED.public;

DROP POLICY IF EXISTS cms_public_read ON storage.objects;
CREATE POLICY cms_public_read ON storage.objects
  FOR SELECT TO public
  USING (bucket_id = 'cms-public');

DROP POLICY IF EXISTS cms_public_insert_super ON storage.objects;
CREATE POLICY cms_public_insert_super ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'cms-public'
    AND public.fn_is_content_super_admin() = true
  );

DROP POLICY IF EXISTS cms_public_update_super ON storage.objects;
CREATE POLICY cms_public_update_super ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'cms-public'
    AND public.fn_is_content_super_admin() = true
  )
  WITH CHECK (
    bucket_id = 'cms-public'
    AND public.fn_is_content_super_admin() = true
  );

DROP POLICY IF EXISTS cms_public_delete_super ON storage.objects;
CREATE POLICY cms_public_delete_super ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'cms-public'
    AND public.fn_is_content_super_admin() = true
  );

-- ---------------------------------------------------------------------------
-- Web Push + FCM（原 002 已合并；旧库重复执行本段可 idempotent 升级）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      TEXT NOT NULL,
  platform     TEXT NOT NULL DEFAULT 'webpush',
  endpoint     TEXT,
  p256dh       TEXT,
  auth         TEXT,
  fcm_token    TEXT,
  language     TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE push_subscriptions
  ADD COLUMN IF NOT EXISTS platform TEXT NOT NULL DEFAULT 'webpush';

ALTER TABLE push_subscriptions
  ADD COLUMN IF NOT EXISTS fcm_token TEXT;

-- 每条订阅记录的语言偏好（由客户端注册时随 /push/subscribe 传入）。
-- _shared/push.ts 根据本字段挑选本地化标题 / 媒体占位符。NULL 时降级到英文。
ALTER TABLE push_subscriptions
  ADD COLUMN IF NOT EXISTS language TEXT;

ALTER TABLE push_subscriptions
  ALTER COLUMN endpoint DROP NOT NULL;

ALTER TABLE push_subscriptions
  DROP CONSTRAINT IF EXISTS push_subscriptions_user_id_endpoint_key;

DROP INDEX IF EXISTS idx_push_subscriptions_user_web;
DROP INDEX IF EXISTS idx_push_subscriptions_user_fcm;

CREATE UNIQUE INDEX IF NOT EXISTS idx_push_subscriptions_user_web
  ON push_subscriptions (user_id, endpoint)
  WHERE platform = 'webpush' AND endpoint IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_push_subscriptions_user_fcm
  ON push_subscriptions (user_id, fcm_token)
  WHERE platform = 'fcm' AND fcm_token IS NOT NULL;

COMMENT ON COLUMN push_subscriptions.platform IS 'webpush | fcm | apns (reserved)';
COMMENT ON COLUMN push_subscriptions.fcm_token IS 'FCM device token when platform=fcm; endpoint/p256dh/auth null';
COMMENT ON COLUMN push_subscriptions.language IS 'BCP-47 ish language tag (en, zh, zh-TW, es, ...) for push i18n; NULL = fallback to English';

ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS push_subscriptions_service ON push_subscriptions;
CREATE POLICY push_subscriptions_service ON push_subscriptions
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE merchant_bind_tokens IS 'LEGACY (read-only). Not written/read by app code since account-based QR migration; kept for rollback safety, safe to drop in a future migration.';
COMMENT ON COLUMN merchant_bind_tokens.merchant_user_id IS 'LEGACY: Supabase Auth user id of store operator; kept for historical rows only';
COMMENT ON COLUMN merchant_bind_tokens.sequence_num IS 'LEGACY: batch index from old merchant-bind-pool flow';

COMMENT ON TABLE chat_messages IS 'Supabase chat channel messages; writes via chat-supabase Edge only';

-- 仅 authenticated 可 SELECT（需通过 merchant_farmer_channels RLS 校验参与者身份）
GRANT SELECT ON TABLE chat_messages TO authenticated;

-- ---------------------------------------------------------------------------
-- 10a. 聊天防刷 — /upload/sign 频次（chat_messages 不含「仅要签名未发消息」的记录，故单独窄表）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chat_rl_upload_sign (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chat_rl_upload_sign_user_created
  ON chat_rl_upload_sign (user_id, created_at DESC);

ALTER TABLE chat_rl_upload_sign ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'chat_rl_upload_sign' AND policyname = 'chat_rl_upload_sign_service_role_only'
  ) THEN
    CREATE POLICY "chat_rl_upload_sign_service_role_only"
      ON chat_rl_upload_sign FOR ALL
      USING (auth.role() = 'service_role')
      WITH CHECK (auth.role() = 'service_role');
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.purge_chat_rl_upload_sign_older_than(p_days int DEFAULT 2)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n INT;
BEGIN
  DELETE FROM chat_rl_upload_sign
   WHERE created_at < now() - (p_days || ' days')::INTERVAL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;

REVOKE ALL ON FUNCTION public.purge_chat_rl_upload_sign_older_than(INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.purge_chat_rl_upload_sign_older_than(INT) TO service_role;
GRANT EXECUTE ON FUNCTION public.purge_chat_rl_upload_sign_older_than(INT) TO postgres;

DO $reschedule_chat_rl_sign_purge$
DECLARE
  r RECORD;
  has_cron BOOLEAN;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') INTO has_cron;
  IF NOT has_cron THEN
    RAISE NOTICE 'pg_cron not installed — skip chat_rl_upload_sign purge schedule.';
    RETURN;
  END IF;

  FOR r IN
    SELECT jobid, jobname FROM cron.job
    WHERE jobname IN ('purge-chat-rl-upload-sign-2d')
  LOOP
    PERFORM cron.unschedule(r.jobid);
    RAISE NOTICE 'unscheduled cron job %', r.jobname;
  END LOOP;

  PERFORM cron.schedule(
    'purge-chat-rl-upload-sign-2d',
    '41 4 * * *',
    'SELECT public.purge_chat_rl_upload_sign_older_than(2);'
  );
  RAISE NOTICE 'scheduled purge-chat-rl-upload-sign-2d (daily @ 04:41, retention=2d)';
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'pg_cron schedule failed (%); DELETE FROM chat_rl_upload_sign WHERE created_at < now() - interval ''2 days'' manually', SQLERRM;
END
$reschedule_chat_rl_sign_purge$;

-- ---------------------------------------------------------------------------
-- 10a-merch. 门店扫码绑定防刷 — merchant_bind_rl（Edge merchant-bind-resolve / MERCHANT_BIND_RL_*）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS merchant_bind_rl (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_merchant_bind_rl_user_created
  ON merchant_bind_rl (user_id, created_at DESC);

ALTER TABLE merchant_bind_rl ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'merchant_bind_rl' AND policyname = 'merchant_bind_rl_service_role_only'
  ) THEN
    CREATE POLICY "merchant_bind_rl_service_role_only"
      ON merchant_bind_rl FOR ALL
      USING (auth.role() = 'service_role')
      WITH CHECK (auth.role() = 'service_role');
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.purge_merchant_bind_rl_older_than(p_days int DEFAULT 7)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n INT;
BEGIN
  DELETE FROM merchant_bind_rl
   WHERE created_at < now() - (p_days || ' days')::INTERVAL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;

REVOKE ALL ON FUNCTION public.purge_merchant_bind_rl_older_than(INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.purge_merchant_bind_rl_older_than(INT) TO service_role;
GRANT EXECUTE ON FUNCTION public.purge_merchant_bind_rl_older_than(INT) TO postgres;

DO $reschedule_merchant_bind_rl_purge$
DECLARE
  r RECORD;
  has_cron BOOLEAN;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') INTO has_cron;
  IF NOT has_cron THEN
    RAISE NOTICE 'pg_cron not installed — skip merchant_bind_rl purge schedule.';
    RETURN;
  END IF;

  FOR r IN
    SELECT jobid, jobname FROM cron.job
    WHERE jobname IN ('purge-merchant-bind-rl-7d')
  LOOP
    PERFORM cron.unschedule(r.jobid);
    RAISE NOTICE 'unscheduled cron job %', r.jobname;
  END LOOP;

  PERFORM cron.schedule(
    'purge-merchant-bind-rl-7d',
    '52 4 * * *',
    'SELECT public.purge_merchant_bind_rl_older_than(7);'
  );
  RAISE NOTICE 'scheduled purge-merchant-bind-rl-7d (daily @ 04:52, retention=7d)';
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'pg_cron schedule failed (%); DELETE FROM merchant_bind_rl WHERE created_at < now() - interval ''7 days'' manually', SQLERRM;
END
$reschedule_merchant_bind_rl_purge$;

-- ---------------------------------------------------------------------------
-- 10b. Supabase 聊天：云端消息/媒体保留（仅 chat_messages + chat-media；腾讯 IM / CometChat 不写本表）
-- ---------------------------------------------------------------------------
-- 云端策略：保留 24 小时（每小时清理 chat_messages + chat-media 桶）。
-- 客户端策略：消息 + 媒体 blob 落 IndexedDB（见 src/app/services/chatLocalStore.ts），
--            历史长期保留靠手机本地；loadOlder 先本地后服务端。
-- 无 pg_cron 时可用 Edge POST /admin/purge-old（见 farmer-developer/SUPABASE_CN.md）。
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.purge_chat_messages_older_than(p_days int DEFAULT 14)
RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH deleted AS (
    DELETE FROM chat_messages
    WHERE created_at < now() - (p_days || ' days')::interval
    RETURNING id
  )
  SELECT count(*)::bigint FROM deleted;
$$;

COMMENT ON FUNCTION public.purge_chat_messages_older_than(int) IS
  'Supabase chat only: DELETE chat_messages rows older than p_days; Tencent/CometChat unaffected.';

REVOKE ALL ON FUNCTION public.purge_chat_messages_older_than(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.purge_chat_messages_older_than(int) TO service_role;
GRANT EXECUTE ON FUNCTION public.purge_chat_messages_older_than(int) TO postgres;

CREATE OR REPLACE FUNCTION public.purge_chat_media_storage_older_than(p_days int DEFAULT 14)
RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, storage
AS $$
  WITH deleted AS (
    DELETE FROM storage.objects o
    USING storage.buckets b
    WHERE o.bucket_id = b.id
      AND b.name = 'chat-media'
      AND o.created_at < now() - (p_days || ' days')::interval
    RETURNING o.id
  )
  SELECT count(*)::bigint FROM deleted;
$$;

COMMENT ON FUNCTION public.purge_chat_media_storage_older_than(int) IS
  'Optional: delete storage.objects in chat-media bucket older than p_days (age-based; not orphan-URL aware).';

REVOKE ALL ON FUNCTION public.purge_chat_media_storage_older_than(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.purge_chat_media_storage_older_than(int) TO service_role;
GRANT EXECUTE ON FUNCTION public.purge_chat_media_storage_older_than(int) TO postgres;

-- pg_cron 调度：每小时清理 messages + storage，保留窗口 = 1 天
-- 取消所有旧任务（14d / 1d 双版本）→ 重新挂 1d 每小时任务；错峰 :07 / :23
DO $reschedule_chat_purge_24h$
DECLARE
  r RECORD;
  has_cron BOOLEAN;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') INTO has_cron;
  IF NOT has_cron THEN
    RAISE NOTICE
      'pg_cron not installed — enable it in Dashboard → Database → Extensions, then re-run this migration. '
      'Workaround: schedule POST /chat-supabase/admin/purge-old { days:1, includeStorage:true } from your own scheduler.';
    RETURN;
  END IF;

  -- 取消所有旧的 chat purge 任务（避免与 24h 任务并存）
  FOR r IN
    SELECT jobid, jobname FROM cron.job
    WHERE jobname IN (
      'purge-chat-messages-14d',
      'purge-chat-messages-1d',
      'purge-chat-storage-1d'
    )
  LOOP
    PERFORM cron.unschedule(r.jobid);
    RAISE NOTICE 'unscheduled cron job %', r.jobname;
  END LOOP;

  -- 每小时清理 chat_messages 中 created_at < now() - 1 day
  PERFORM cron.schedule(
    'purge-chat-messages-1d',
    '7 * * * *',  -- 每小时第 7 分（错峰 storage 任务）
    'SELECT public.purge_chat_messages_older_than(1);'
  );
  RAISE NOTICE 'scheduled purge-chat-messages-1d (hourly @ :07, retention=1d)';

  -- 每小时清理 chat-media bucket 中 created_at < now() - 1 day
  PERFORM cron.schedule(
    'purge-chat-storage-1d',
    '23 * * * *', -- 每小时第 23 分（与 messages 错峰，留出复制延迟空间）
    'SELECT public.purge_chat_media_storage_older_than(1);'
  );
  RAISE NOTICE 'scheduled purge-chat-storage-1d (hourly @ :23, retention=1d)';

EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'pg_cron schedule failed (%); fall back to Edge /admin/purge-old', SQLERRM;
END
$reschedule_chat_purge_24h$;

-- ---------------------------------------------------------------------------
-- 10c. cms-public：删除未被 app_config / config_history 引用的对象（未推送草稿图等）
-- ---------------------------------------------------------------------------
-- 从当前主配置与全部历史 JSON 文本中提取引用路径：
--   - storage/v1/object/public/cms-public/<path>（legacy Supabase URL）
--   - content/<...> 相对路径
--   - /media/<...> CDN URL
-- 其余 bucket 内对象若 created_at 早于 p_min_age（默认 24 小时）则删除。
-- 仅依赖远程 JSON；仅保存到本机、从未推送的 URL 不会被引用，到期后删除。
-- （原 002_cms_media_cdn.sql 已并入本节）
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.purge_cms_public_unreferenced_older_than(
  p_min_age interval DEFAULT interval '24 hours'
)
RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, storage
AS $$
  WITH
  hay AS (
    SELECT
      COALESCE((SELECT ac.config::text FROM public.app_config ac WHERE ac.id = 'main'), '')
      || ' '
      || COALESCE((SELECT string_agg(ch.config::text, ' ') FROM public.config_history ch), '') AS h
  ),
  ref_matches AS (
    SELECT rm[1] AS raw_path
    FROM hay,
    LATERAL regexp_matches(
      hay.h,
      'storage/v1/object/public/cms-public/([^"\s?]+)',
      'gi'
    ) AS rm
    UNION
    SELECT rm[1] AS raw_path
    FROM hay,
    LATERAL regexp_matches(
      hay.h,
      '(content/[a-zA-Z0-9._-]+/[0-9]+-[^"\s?\\]+)',
      'gi'
    ) AS rm
    UNION
    SELECT rm[1] AS raw_path
    FROM hay,
    LATERAL regexp_matches(
      hay.h,
      '/media/([^"\s?]+)',
      'gi'
    ) AS rm
  ),
  ref_paths AS (
    SELECT DISTINCT
      trim(
        both '/'
        FROM replace(
          replace(
            replace(raw_path, '%2F', '/'),
            '%20', ' '
          ),
          '%2B', '+'
        )
      ) AS path
    FROM ref_matches
    WHERE raw_path IS NOT NULL AND btrim(raw_path) <> ''
  ),
  deleted AS (
    DELETE FROM storage.objects o
    WHERE o.bucket_id = 'cms-public'
      AND o.created_at < now() - p_min_age
      AND NOT EXISTS (
        SELECT 1
        FROM ref_paths r
        WHERE r.path IS NOT NULL
          AND r.path <> ''
          AND o.name = r.path
      )
    RETURNING o.id
  )
  SELECT count(*)::bigint FROM deleted;
$$;

COMMENT ON FUNCTION public.purge_cms_public_unreferenced_older_than(interval) IS
  'Delete cms-public objects older than p_min_age (default 24h) not referenced in app_config/config_history: legacy public URLs, relative content/ paths, or /media/ CDN paths.';

REVOKE ALL ON FUNCTION public.purge_cms_public_unreferenced_older_than(interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.purge_cms_public_unreferenced_older_than(interval) TO service_role;
GRANT EXECUTE ON FUNCTION public.purge_cms_public_unreferenced_older_than(interval) TO postgres;

DO $schedule_cms_public_orphan_purge$
DECLARE
  r RECORD;
  has_cron BOOLEAN;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') INTO has_cron;
  IF NOT has_cron THEN
    RAISE NOTICE
      'pg_cron not installed — skip cms-public orphan purge. '
      'Run manually: SELECT public.purge_cms_public_unreferenced_older_than(interval ''24 hours'');';
    RETURN;
  END IF;

  FOR r IN
    SELECT jobid, jobname FROM cron.job
    WHERE jobname IN ('purge-cms-public-orphans-1h', 'purge-cms-public-orphans-24h')
  LOOP
    PERFORM cron.unschedule(r.jobid);
    RAISE NOTICE 'unscheduled cron job %', r.jobname;
  END LOOP;

  PERFORM cron.schedule(
    'purge-cms-public-orphans-24h',
    '47 * * * *',
    'SELECT public.purge_cms_public_unreferenced_older_than(interval ''24 hours'');'
  );
  RAISE NOTICE 'scheduled purge-cms-public-orphans-24h (hourly @ :47, min_age=24h, refs=app_config+config_history)';
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'pg_cron schedule failed (%); run purge_cms_public_unreferenced_older_than manually', SQLERRM;
END
$schedule_cms_public_orphan_purge$;


-- ============================================================================
-- 11. 账号级绑定 —— merchant_farmer_channels（account-based QR flow）
-- ============================================================================
-- 注：本表的 CREATE TABLE / 索引 / RLS 已上移到第 10 节内（在 chat_messages
--     RLS 策略之前），因为 chat_messages_select_participants 策略的 USING
--     表达式会引用 merchant_farmer_channels，PostgreSQL 在 CREATE POLICY 时
--     校验引用表必须已存在。此节仅保留文档说明，不再重复建表。
-- ============================================================================


-- ============================================================================
-- 12. farmer_merchant_bindings —— 农户视角的云端绑定记录（跨设备恢复 chatContact）
-- ============================================================================
-- 农户扫码后 Edge 同步写入；farmer 可凭自己的 JWT 读/删。换设备登录时由前端 rehydrate chatContact。
-- ============================================================================

CREATE TABLE IF NOT EXISTS farmer_merchant_bindings (
  farmer_user_id   UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  merchant_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  channel_id       TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (farmer_user_id, merchant_user_id)
);

CREATE INDEX IF NOT EXISTS idx_farmer_merchant_bindings_farmer_recent
  ON farmer_merchant_bindings (farmer_user_id, created_at DESC);

ALTER TABLE farmer_merchant_bindings ENABLE ROW LEVEL SECURITY;

-- Edge 全权读写
DROP POLICY IF EXISTS farmer_merchant_bindings_service ON farmer_merchant_bindings;
CREATE POLICY farmer_merchant_bindings_service ON farmer_merchant_bindings
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 农户自己可 SELECT / DELETE（用于清除或切换绑定）
DROP POLICY IF EXISTS farmer_merchant_bindings_select_own ON farmer_merchant_bindings;
CREATE POLICY farmer_merchant_bindings_select_own ON farmer_merchant_bindings
  FOR SELECT TO authenticated
  USING (farmer_user_id = auth.uid());

DROP POLICY IF EXISTS farmer_merchant_bindings_delete_own ON farmer_merchant_bindings;
CREATE POLICY farmer_merchant_bindings_delete_own ON farmer_merchant_bindings
  FOR DELETE TO authenticated
  USING (farmer_user_id = auth.uid());

GRANT SELECT, DELETE ON TABLE farmer_merchant_bindings TO authenticated;

COMMENT ON TABLE farmer_merchant_bindings IS
  'Farmer-facing cloud record of bound merchants (account-based QR). Writes via Edge; farmer can SELECT/DELETE own rows.';

-- 农户 JWT 可读「已绑定门店」的 user_profiles 行，便于前端 farmerBindingRepo 拉 display_name / avatar_url 跨设备恢复聊天顶栏（原仅 service_role 会读不到商户资料）
DROP POLICY IF EXISTS user_profiles_select_for_bound_farmer ON public.user_profiles;
CREATE POLICY user_profiles_select_for_bound_farmer ON public.user_profiles
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.farmer_merchant_bindings b
      WHERE b.merchant_user_id = user_profiles.user_id
        AND b.farmer_user_id = (SELECT auth.uid())
    )
  );


-- ============================================================================
-- 13. 聊天链路成本优化（原 002_chat_cost_optimizations.sql 并入）
-- ============================================================================
-- 前提：方案 C（broadcast + 严格生命周期）已部署并稳定 ≥ 24h。
-- 目标：
--   A1) 把 chat_messages 从 supabase_realtime publication 里移除 —— 停掉
--       logical replication 的扫行与过滤开销（我们改用 Edge 写后广播）。
--   A2) 给 Realtime broadcast 频道 chat:<channel_id> 加 RLS —— 只有该
--       (merchant_user_id, farmer_user_id) 配对的用户才能订阅，拒绝滥订阅。
-- 幂等：可重复执行；失败回滚见文末。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- A1. chat_messages 移出 supabase_realtime publication
-- ---------------------------------------------------------------------------
-- 条件：
--   1. 线上前端已全部切到 broadcast 订阅（Dashboard → Realtime 面板
--      postgres_changes 并发 ≈ 0）。
--   2. Edge chat-supabase 部署版本 >= broadcast 版本。
-- 影响：
--   - 老客户端（仍用 postgres_changes）会失去实时推送，历史仍可通过
--     GET /messages 拉取；可通过推送强制刷新完成过渡。
-- ---------------------------------------------------------------------------
DO $drop_chat_from_realtime_pub$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'chat_messages'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime DROP TABLE public.chat_messages';
    RAISE NOTICE 'A1: chat_messages removed from supabase_realtime publication';
  ELSE
    RAISE NOTICE 'A1: chat_messages not in supabase_realtime publication (already done or fresh DB)';
  END IF;
END
$drop_chat_from_realtime_pub$;


-- ---------------------------------------------------------------------------
-- A2. Realtime Broadcast 鉴权（RLS on realtime.messages）
-- ---------------------------------------------------------------------------
-- Supabase Realtime Authorization 的核心思路：
--   realtime.messages 是承载 broadcast / presence 等实时帧的表；
--   当客户端发起 channel.subscribe() 时，Realtime 会以当前 JWT 的身份
--   对 realtime.messages 做 SELECT 权限检查（topic 从 extension 中取）。
--   我们在这里声明："只有 chat:<channel_id> 对应的门店或农户可以订阅"。
--
-- 我们只约束 SELECT（订阅侧）。客户端不会走 INSERT（publish 全部由
--   service_role 的 Edge Function 完成，默认即绕过 RLS）。
-- ---------------------------------------------------------------------------

-- 启用 RLS（Supabase 托管实例默认已启用；IF NOT EXISTS 同义；此处显式声明幂等）
DO $enable_realtime_rls$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'realtime' AND c.relname = 'messages'
  ) THEN
    BEGIN
      EXECUTE 'ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY';
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'A2: realtime.messages RLS already managed by platform — skip ENABLE';
    END;
  ELSE
    RAISE NOTICE 'A2: realtime.messages table not found — skipping';
  END IF;
END
$enable_realtime_rls$;


-- 帮助函数：当前 JWT 是否为 chat:<channel_id> 的参与者
-- （门店 auth.uid() = merchant_user_id，或 农户 auth.uid()::text = farmer_user_id）
CREATE OR REPLACE FUNCTION public.is_chat_channel_participant(p_topic TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_channel TEXT;
  v_uid UUID;
BEGIN
  IF p_topic IS NULL OR p_topic NOT LIKE 'chat:%' THEN
    RETURN false;
  END IF;

  v_channel := substring(p_topic FROM 6);  -- strip leading 'chat:'
  IF length(v_channel) = 0 THEN
    RETURN false;
  END IF;

  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
    SELECT 1 FROM public.merchant_farmer_channels mfc
    WHERE mfc.channel_id = v_channel
      AND (
        mfc.merchant_user_id = v_uid
        OR mfc.farmer_user_id = v_uid::text
      )
  );
END;
$$;

COMMENT ON FUNCTION public.is_chat_channel_participant(TEXT) IS
  'A2: Realtime Authorization helper — true when auth.uid() is participant of chat:<channel_id>.';

REVOKE ALL ON FUNCTION public.is_chat_channel_participant(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_chat_channel_participant(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_chat_channel_participant(TEXT) TO service_role;


-- 实际策略：订阅（SELECT）限制为参与者；非 chat:* topic 走默认（Supabase 托管策略通常允许）
DO $create_realtime_policy$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'realtime' AND c.relname = 'messages'
  ) THEN
    BEGIN
      EXECUTE 'DROP POLICY IF EXISTS chat_broadcast_participants_only ON realtime.messages';
      EXECUTE $policy$
        CREATE POLICY chat_broadcast_participants_only
          ON realtime.messages
          FOR SELECT
          TO authenticated
          USING (
            -- 非 chat:* topic 不在本策略约束范围 —— Supabase 其它默认策略继续适用
            (realtime.topic()) NOT LIKE 'chat:%'
            OR public.is_chat_channel_participant(realtime.topic())
          )
      $policy$;
      RAISE NOTICE 'A2: policy chat_broadcast_participants_only created on realtime.messages';
    EXCEPTION
      WHEN insufficient_privilege THEN
        RAISE NOTICE 'A2: insufficient privilege to manage realtime.messages policies — apply via Dashboard SQL Editor with a superuser role';
      WHEN undefined_function THEN
        RAISE NOTICE 'A2: realtime.topic() function not exposed on this project — open Dashboard → Realtime → Authorization to enable, then re-run this migration';
    END;
  END IF;
END
$create_realtime_policy$;

-- 回滚（紧急）：
--   DROP POLICY IF EXISTS chat_broadcast_participants_only ON realtime.messages;
--   DROP FUNCTION IF EXISTS public.is_chat_channel_participant(TEXT);
--   ALTER PUBLICATION supabase_realtime ADD TABLE public.chat_messages;
-- 取消 24h cron、恢复 14d：
--   SELECT cron.unschedule(jobid) FROM cron.job
--    WHERE jobname IN ('purge-chat-messages-1d', 'purge-chat-storage-1d');
--   SELECT cron.schedule('purge-chat-messages-14d', '0 3 * * *',
--     'SELECT public.purge_chat_messages_older_than(14);');


-- ============================================================================
-- 完成！
-- ============================================================================
--
-- 🎉 部署完成！接下来：
--
-- ┌─────────────────────────────────────────────────────────────────────┐
-- │  第一步：部署 Edge Functions                                        │
-- │  运行: supabase functions deploy server                            │
-- │        supabase functions deploy chat-supabase                     │
-- │        supabase functions deploy merchant-bind-resolve             │
-- │        supabase functions deploy ai-vision-proxy                   │
-- │                                                                     │
-- │  第二步：在 PWA ConfigManagerPage 中配置连接                         │
-- │  填入: Supabase URL + Anon Key                                     │
-- │  点击: 测试连接                                                     │
-- │                                                                     │
-- │  第三步：开始管理内容！                                              │
-- │  在 Dashboard > Table Editor > app_config 中编辑 config 列          │
-- └─────────────────────────────────────────────────────────────────────┘
--
-- 常用 SQL 命令速查：
--
--   -- 查看配置概览
--   SELECT * FROM get_config_overview();
--
--   -- 读取某个区块
--   SELECT get_config_section('articles');
--   SELECT get_config_section('appBranding');
--
--   -- 更新文章列表
--   SELECT update_config_section('articles', '[{"id":1,"title":"新标题",...}]'::jsonb);
--
--   -- 更新品牌名
--   SELECT update_config_section('appBranding', '{"logoUrl":"","appName":"MyFarm","slogan":"Smart"}'::jsonb);
--
--   -- 搜索配置内容
--   SELECT * FROM search_config('小麦');
--
--   -- 查看历史版本
--   SELECT version, created_at, note FROM config_history ORDER BY version DESC LIMIT 20;
--
--   -- 回滚到版本 N
--   SELECT rollback_config(3);
--
--   -- 查看当前版本号
--   SELECT version, updated_at, updated_by FROM app_config WHERE id = 'main';
--
-- ============================================================================