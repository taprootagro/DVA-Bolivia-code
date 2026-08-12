import { mergeAttributes } from "@tiptap/core";
import Image from "@tiptap/extension-image";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { CmsImageView } from "./CmsImageView";

export type CmsImageAlign = "left" | "center" | "right";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    image: {
      setImage: (options: {
        src: string;
        alt?: string;
        title?: string;
        width?: string | null;
        dataAlign?: CmsImageAlign;
      }) => ReturnType;
    };
  }
}

/**
 * 图片：允许 width 与 data-align，序列化为可经 DOMPurify 保留的 img 属性 + 受控内联 style。
 * 不启用 base64；由编辑器粘贴/上传后写入 https URL。
 */
export const CmsImage = Image.extend({
  name: "image",

  /**
   * 关闭整节点拖拽，避免与右下角缩放手势冲突、减少浮动图在滚动时的异常位移。
   * 与 React NodeView 的缩放手柄配合使用。
   */
  draggable: false,

  addOptions() {
    return {
      inline: false,
      allowBase64: false,
      HTMLAttributes: { class: "rich-content-img" },
    };
  },

  addAttributes() {
    return {
      src: { default: null },
      alt: { default: null },
      title: { default: null },
      width: { default: null },
      dataAlign: { default: "center" as CmsImageAlign | null },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'img[src]:not([src^="data:"])',
        getAttrs: (dom) => {
          const el = dom as HTMLImageElement;
          const src = el.getAttribute("src");
          if (!src) return false;
          const wAttr = el.getAttribute("width");
          const wStyle = (el.getAttribute("style") || "")
            .split(";")
            .map((s) => s.trim())
            .find((s) => /^width\s*:/i.test(s));
          let width: string | null = wAttr;
          if (!width && wStyle) {
            width = wStyle.replace(/^width\s*:\s*/i, "").trim() || null;
          } else if (!width) {
            width = el.style?.width || null;
          }
          const da = el.getAttribute("data-align");
          const fl = (el.style?.float || "").toLowerCase();
          let dataAlign: CmsImageAlign =
            da === "left" || da === "right" || da === "center" ? (da as CmsImageAlign) : "center";
          if (!da) {
            if (fl === "left") dataAlign = "left";
            else if (fl === "right") dataAlign = "right";
          }
          return {
            src,
            alt: el.getAttribute("alt"),
            title: el.getAttribute("title"),
            width: width || null,
            dataAlign,
          };
        },
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    const { src, alt, title, width, dataAlign } = node.attrs as {
      src: string | null;
      alt: string | null;
      title: string | null;
      width: string | null;
      dataAlign: CmsImageAlign | null;
    };
    const style: string[] = ["height:auto", "border-radius:8px", "object-fit:contain", "box-sizing:border-box"];
    if (width) {
      const w = String(width).trim();
      if (/^[\d.]+$/.test(w)) {
        style.push(`width:${w}px`);
      } else {
        style.push(`width:${w}`);
      }
    }
    style.push("max-width:100%");
    const al = dataAlign || "center";
    if (al === "left") {
      style.push("float:left", "margin:8px 12px 8px 0");
    } else if (al === "right") {
      style.push("float:right", "margin:8px 0 8px 12px");
    } else {
      style.push("float:none", "display:block", "margin:8px auto", "clear:both");
    }
    return [
      "img",
      mergeAttributes(
        { src, alt, title, style: style.join(";"), "data-align": al || "center" },
        this.options.HTMLAttributes,
        HTMLAttributes,
      ),
    ];
  },

  addCommands() {
    return {
      setImage: (options) => ({ commands }) => {
        return commands.insertContent({
          type: this.name,
          attrs: {
            src: options.src,
            alt: options.alt ?? null,
            title: options.title ?? null,
            width: (options as { width?: string | null }).width ?? null,
            dataAlign: (options as { dataAlign?: CmsImageAlign }).dataAlign ?? "center",
          },
        });
      },
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(CmsImageView, { as: "div", className: "cms-image-node-view" });
  },
});

