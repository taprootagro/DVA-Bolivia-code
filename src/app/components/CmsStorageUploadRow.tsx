import { useRef, useState } from "react";
import { Upload, Loader2 } from "lucide-react";
import { useLanguage } from "../hooks/useLanguage";
import { createCmsTranslator } from "../i18n/cmsTranslate";
import enTranslations from "../i18n/lang/en";
import { getServerUserId } from "../utils/auth";
import { uploadFileToCmsPublic, CMS_PUBLIC_BUCKET } from "../utils/cmsPublicUpload";

export { CMS_PUBLIC_BUCKET };

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_VIDEO_BYTES = 80 * 1024 * 1024;

export type CmsUploadMode = "image" | "video" | "media";

type Props = {
  label: string;
  value: string;
  onChange: (url: string) => void;
  mode?: CmsUploadMode;
};

export function CmsStorageUploadRow({ label, value, onChange, mode = "media" }: Props) {
  const { t, language } = useLanguage();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const ct = createCmsTranslator(t, language, enTranslations);

  const accept =
    mode === "image"
      ? "image/*"
      : mode === "video"
        ? "video/mp4,video/webm,video/quicktime"
        : "image/*,video/mp4,video/webm,video/quicktime";

  const pick = async (file: File) => {
    setErr(null);
    const isVid = file.type.startsWith("video/");
    const max = isVid ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
    if (file.size > max) {
      setErr(
        ct(
          `文件过大（上限 ${Math.round(max / (1024 * 1024))}MB）`,
          `File too large (max ${Math.round(max / (1024 * 1024))}MB)`,
        ),
      );
      return;
    }
    if (!getServerUserId()) {
      setErr(ct("messages.supabase_sign_in_required", "需要已登录的 Supabase 会话。", "Supabase sign-in required."));
      return;
    }
    setBusy(true);
    try {
      const result = await uploadFileToCmsPublic(file);
      if ('error' in result) {
        if (result.rlsDenied) {
          setErr(
            ct("messages.upload_denied_set_content_super_admin_for_your", "上传被拒绝：需要内容管理员权限。请在 Supabase SQL Editor 执行：UPDATE public.user_profiles SET content_super_admin = true WHERE user_id = '<您的 auth.users.id>'；并确保已用该账号登录。详见部署文档。", "Upload denied: set content_super_admin for your user. In SQL Editor: UPDATE public.user_profiles SET content_super_admin = true WHERE user_id = '<your auth.users id>'; then sign in again. See deploy docs."),
          );
        } else {
          setErr(result.error);
        }
        return;
      }
      onChange(result.storagePath);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void pick(f);
          }}
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
          className="inline-flex items-center gap-1.5 px-3 py-2 text-sm rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
        >
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
          {ct("messages.upload_to_server", "上传到服务器", "Upload to server")}
        </button>
        <span className="text-[11px] text-gray-500">
          {ct("messages.or_paste_external_url_e_g_cloudflare_r2", "或直接粘贴外链（如 Cloudflare R2）", "Or paste external URL (e.g. Cloudflare R2)")}
        </span>
      </div>
      <input
        type="text"
        value={value || ""}
        onChange={(e) => onChange(e.target.value)}
        placeholder="https://..."
        className="mt-2 w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 font-mono text-xs"
      />
      {err && <p className="mt-1 text-xs text-red-600">{err}</p>}
    </div>
  );
}
