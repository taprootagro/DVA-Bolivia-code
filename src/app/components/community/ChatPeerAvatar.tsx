import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { User } from "lucide-react";
import { useLanguage } from "../../hooks/useLanguage";
import { useCmsMediaUrl } from "../../hooks/useCmsMediaUrl";
import {
  peekCachedObjectUrl,
  resolveCachedMediaUrl,
} from "../../services/chatUiMemory";

const SIZES = {
  sm: { box: "w-8 h-8", icon: "w-4 h-4" },
  md: { box: "w-11 h-11", icon: "w-5 h-5" },
  lg: { box: "w-12 h-12", icon: "w-7 h-7" },
} as const;

type ChatPeerAvatarSize = keyof typeof SIZES;

/** http(s)、data:image、blob 才能交给 img。相对路径要先 resolve，否则会打到页面域名上变成破图。 */
export function isDisplayableAvatarUrl(src: string): boolean {
  const s = src.trim();
  if (!s) return false;
  if (s.startsWith("blob:")) return true;
  if (s.startsWith("data:image/")) return true;
  return /^https?:\/\//i.test(s);
}

function useCachedAvatarSrc(rawUrl: string): string {
  const { resolve } = useCmsMediaUrl();
  const url = resolve(rawUrl);
  const [src, setSrc] = useState("");

  useEffect(() => {
    const next = (url || "").trim();
    if (!isDisplayableAvatarUrl(next)) {
      setSrc("");
      return;
    }
    if (next.startsWith("blob:") || next.startsWith("data:")) {
      setSrc(next);
      return;
    }
    const peeked = peekCachedObjectUrl(next);
    if (peeked) {
      setSrc(peeked);
      return;
    }
    setSrc(next);
    let cancelled = false;
    void resolveCachedMediaUrl(next).then((resolved) => {
      if (cancelled) return;
      if (resolved && isDisplayableAvatarUrl(resolved)) setSrc(resolved);
    });
    return () => {
      cancelled = true;
    };
  }, [url]);

  return src;
}

function AvatarFallback({
  box,
  icon,
  className,
}: {
  box: string;
  icon: string;
  className: string;
}) {
  return (
    <div
      className={`${box} rounded-full overflow-hidden bg-white flex items-center justify-center flex-shrink-0 ${className}`}
      aria-hidden
    >
      <User className={`${icon} shrink-0 text-emerald-600`} strokeWidth={2.2} />
    </div>
  );
}

/**
 * 聊天列表/会话头默认头像：与底部 Dock「我的」、农户单聊顶栏一致（lucide User + 品牌绿）。
 * 远程头像走 IndexedDB + 内存 objectURL，避免每次打开通讯录重新拉图。
 * 加载失败或地址不可用时回退到 User 图标，避免破碎图片。
 */
export function ChatPeerAvatar({
  avatar,
  userId,
  size = "lg",
  className = "",
}: {
  avatar?: string;
  userId?: string;
  size?: ChatPeerAvatarSize;
  className?: string;
}) {
  const { t } = useLanguage();
  const s = SIZES[size];
  const src = useCachedAvatarSrc((avatar || "").trim());
  const [broken, setBroken] = useState(false);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const id = (userId || "").trim();
  const label = t.community.userIdLabel || "User ID";

  useEffect(() => {
    setBroken(false);
  }, [src]);

  const showImg = Boolean(src) && !broken;
  const face = showImg ? (
    <img
      src={src}
      alt=""
      referrerPolicy="no-referrer"
      className={`${s.box} rounded-full object-cover bg-gray-200 flex-shrink-0 ${className}`}
      decoding="async"
      onError={() => setBroken(true)}
    />
  ) : (
    <AvatarFallback box={s.box} icon={s.icon} className={className} />
  );

  const openCard = (e: React.SyntheticEvent) => {
    e.stopPropagation();
    setCopied(false);
    setOpen(true);
  };

  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const dialog =
    open && typeof document !== "undefined"
      ? createPortal(
          <div
            className="fixed inset-0 z-[200] flex items-end justify-center bg-black/40"
            onClick={() => setOpen(false)}
          >
            <div
              className="w-full max-w-md bg-white rounded-t-2xl px-5 pt-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-xl"
              role="dialog"
              aria-modal="true"
              aria-label={label}
              onClick={(e) => e.stopPropagation()}
            >
              <p className="text-xs text-gray-500">{label}</p>
              <p className="mt-1 text-sm font-mono text-gray-900 break-all select-all">{id}</p>
              <div className="mt-4 flex gap-2">
                <button
                  type="button"
                  className="flex-1 h-10 rounded-xl bg-emerald-600 text-white text-sm font-medium active:opacity-90"
                  onClick={() => void copyId()}
                >
                  {copied
                    ? t.community.userIdCopied || "Copied"
                    : t.community.copyUserId || "Copy"}
                </button>
                <button
                  type="button"
                  className="flex-1 h-10 rounded-xl bg-gray-100 text-gray-800 text-sm font-medium active:opacity-90"
                  onClick={() => setOpen(false)}
                >
                  {t.community.gotIt || "Got it"}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )
      : null;

  if (!id) return face;

  return (
    <>
      <span
        className="inline-flex flex-shrink-0 cursor-pointer"
        aria-label={label}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={openCard}
      >
        {face}
      </span>
      {dialog}
    </>
  );
}
