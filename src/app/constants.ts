// ============================================================================
// App-wide Constants
// ============================================================================
// Single source of truth for magic strings used across the app.
// Avoids silent bugs from copy-pasting the same key in multiple files.
// ============================================================================

/**
 * localStorage key for the merged home/app config（展示文案、轮播、backendProxy 等）。
 * 与认证无关：不存放 Supabase refresh token；`resetConfig` 只重写此 key，不登出。
 */
export const CONFIG_STORAGE_KEY = "agri_home_config";

/** 回到前台时自动 GET /config 的最小间隔（ms）；本地已有 merged 配置时避免每次切 Tab/从设置返回都打网。 */
export const CONFIG_FOREGROUND_PULL_MIN_MS = 10 * 60 * 1000;

/**
 * Set when Config Manager saves locally (mirrorDevFiles). While set, GET /config merge
 * keeps local CMS slices over remote so foreground pulls do not wipe unpublished edits.
 * Cleared after a successful push to cloud or resetConfig.
 */
export const CONFIG_CMS_DIRTY_KEY = "__configCmsDirty";

/**
 * Last successful GET /profile with contentSuperAdmin === true for this userId (local UX only).
 */
export const CONTENT_SUPER_ADMIN_CACHE_KEY = "__taproot_content_super_admin_cache__";

/**
 * localStorage：最近一次成功的 GET /profile 快照（按 userId），用于 Tab/设置 等导致 Profile 卸载再挂载时
 * 先展示旧数据并后台刷新，避免「加载中…」闪烁。
 */
export const EDGE_PROFILE_CACHE_KEY = "__taproot_edge_profile_cache_v1__";

/**
 * sessionStorage：用户曾关闭「待完善资料」编辑层。
 * 若在仅 useRef 保存，在整页离开 /home（如历史里曾用独立 /settings 路由）会丢状态并再次自动弹层；用 session 可兜底。
 */
export const PROFILE_GATE_DISMISSED_SESSION_KEY = "__taproot_profile_gate_dismissed__";

/**
 * sessionStorage: 从「我的」点进设置（或设置页返回个人中心）时跳过「自动弹出资料层」一次。
 * 消费须用 `consumeProfileGateSkipAutoOnce()`：勿在 effect 里同步 remove，否则 Strict Mode 二次挂载会丢 flag。
 */
export const PROFILE_GATE_SKIP_AUTO_ONCE_SESSION_KEY = "__taproot_profile_gate_skip_auto_once__";
