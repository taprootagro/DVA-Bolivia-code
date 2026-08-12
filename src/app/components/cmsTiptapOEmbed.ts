import { Node } from "@tiptap/core";

const IFRAME_ATTRS = {
  class: "rich-embed-iframe__frame",
  width: 640,
  height: 360,
  allowfullscreen: true,
  loading: "lazy" as const,
  referrerpolicy: "strict-origin-when-cross-origin" as const,
  allow:
    "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen",
  style: "max-width:100%;border:0;aspect-ratio:16/9;height:auto;min-height:200px;vertical-align:middle",
};

/**
 * 非 YouTube 的可信 iframe（Vimeo、B 站等），src 在插入前由 videoEmbedFromUrl 规范化。
 */
export const CmsOEmbed = Node.create({
  name: "cmsOEmbed",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      src: {
        default: null,
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: "div[data-cms-embed]",
        getAttrs: (el) => {
          if (!(el instanceof HTMLElement)) return false;
          const f = el.querySelector("iframe");
          const s = f?.getAttribute("src");
          if (!s?.trim()) return false;
          return { src: s.trim() };
        },
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    if (!HTMLAttributes.src) {
      return ["p", 0];
    }
    return [
      "div",
      { "data-cms-embed": "", class: "rich-embed-iframe" },
      [
        "iframe",
        {
          title: "Embedded video",
          ...IFRAME_ATTRS,
          src: String(HTMLAttributes.src),
        },
      ],
    ];
  },

  addCommands() {
    return {
      setCmsOEmbed:
        (src: string) =>
        ({ commands }) => {
          if (!src?.trim()) return false;
          return commands.insertContent({ type: this.name, attrs: { src: src.trim() } });
        },
    };
  },
});

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    setCmsOEmbed: (src: string) => ReturnType;
  }
}
