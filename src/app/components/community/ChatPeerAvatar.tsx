import { User } from "lucide-react";

const SIZES = {
  sm: { box: "w-8 h-8", icon: "w-4 h-4" },
  md: { box: "w-11 h-11", icon: "w-5 h-5" },
  lg: { box: "w-12 h-12", icon: "w-7 h-7" },
} as const;

type ChatPeerAvatarSize = keyof typeof SIZES;

/**
 * 聊天列表/会话头默认头像：与底部 Dock「我的」、农户单聊顶栏一致（lucide User + 品牌绿）。
 */
export function ChatPeerAvatar({
  avatar,
  size = "lg",
  className = "",
}: {
  avatar?: string;
  size?: ChatPeerAvatarSize;
  className?: string;
}) {
  const s = SIZES[size];
  const url = (avatar || "").trim();

  if (url) {
    return (
      <img
        src={url}
        alt=""
        className={`${s.box} rounded-full object-cover bg-gray-200 flex-shrink-0 ${className}`}
        decoding="async"
      />
    );
  }

  return (
    <div
      className={`${s.box} rounded-full overflow-hidden bg-white flex items-center justify-center flex-shrink-0 ${className}`}
      aria-hidden
    >
      <User className={`${s.icon} shrink-0 text-emerald-600`} strokeWidth={2.2} />
    </div>
  );
}
