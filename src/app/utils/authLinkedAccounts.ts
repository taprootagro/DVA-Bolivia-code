import type { User } from "@supabase/supabase-js";

const REGIONAL_EMAIL_RE = /@regional\.oauth\.invalid$/i;

/**
 * 仅 Google 登录展示的邮箱（用于编辑资料「快捷登录账号」；非 Google 登录返回 null）。
 */
export function extractGoogleLinkedEmail(user: User | null | undefined): string | null {
  if (!user) return null;
  for (const id of user.identities || []) {
    if (String(id.provider) !== "google") continue;
    const data = (id.identity_data || {}) as Record<string, unknown>;
    const email = typeof data.email === "string" ? data.email.trim() : "";
    if (email) return email;
  }
  const metaProviders = user.app_metadata?.providers;
  if (
    Array.isArray(metaProviders) &&
    metaProviders.some((p) => String(p).toLowerCase() === "google")
  ) {
    const ue = user.email?.trim() || "";
    if (ue && !REGIONAL_EMAIL_RE.test(ue)) return ue;
  }
  return null;
}

/**
 * 编辑资料页展示：快捷登录绑定的账号（Google 邮箱/手机、微信 openid、支付宝 id 等）。
 * `dbProfile` 来自 Edge GET /profile 的 `profile` JSON（含 regional OAuth 的 provider / wechat_openid）。
 */
export function describeLinkedAuthAccounts(
  user: User | null | undefined,
  dbProfile?: Record<string, unknown> | null,
): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [];
  const push = (label: string, value: string) => {
    const v = value.trim();
    if (!v) return;
    if (rows.some((r) => r.label === label && r.value === v)) return;
    rows.push({ label, value: v });
  };

  const p = dbProfile || {};
  const prov = typeof p.provider === "string" ? p.provider : "";
  if (prov === "wechat") {
    const oid = typeof p.wechat_openid === "string" ? p.wechat_openid.trim() : "";
    const nm = typeof p.name === "string" ? p.name.trim() : "";
    if (oid || nm) {
      push("微信", nm ? (oid ? `${nm}（${oid}）` : nm) : oid);
    }
  }
  if (prov === "alipay") {
    const aid =
      typeof p.alipay_user_id === "string" ? p.alipay_user_id.trim() : "";
    if (aid) push("支付宝", aid);
  }

  if (!user) return rows;

  for (const id of user.identities || []) {
    const provider = String(id.provider || "");
    const data = (id.identity_data || {}) as Record<string, unknown>;
    const email = typeof data.email === "string" ? data.email : "";
    const phone =
      typeof data.phone === "string"
        ? data.phone
        : typeof data.phone_number === "string"
          ? data.phone_number
          : "";

    if (provider === "google") {
      push("Google", email || user.email || "");
    } else if (provider === "phone") {
      push("手机", phone || user.phone || "");
    } else if (provider === "email") {
      const em = email || user.email || "";
      if (em && !REGIONAL_EMAIL_RE.test(em)) push("邮箱", em);
    } else if (provider === "facebook") {
      push("Facebook", email || user.email || "");
    } else if (provider === "apple") {
      push(
        "Apple",
        email ||
          user.email ||
          (typeof data.sub === "string" ? data.sub : ""),
      );
    } else if (provider === "twitter") {
      const un = typeof data.user_name === "string" ? data.user_name : "";
      push("X", un || email || "");
    }
  }

  if (user.phone) push("手机", user.phone);
  const ue = user.email?.trim() || "";
  if (ue && !REGIONAL_EMAIL_RE.test(ue) && !rows.some((r) => r.value === ue)) {
    push("邮箱", ue);
  }

  return rows;
}
