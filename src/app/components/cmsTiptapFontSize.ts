import { Extension } from "@tiptap/core";

/**
 * 与 @tiptap/extension-text-style 的 textStyle 标记配合，将 fontSize 存为内联 style。
 */
export const CmsFontSize = Extension.create({
  name: "cmsFontSize",

  addOptions() {
    return {
      types: ["textStyle" as const],
    };
  },

  addGlobalAttributes() {
    return [
      {
        types: this.options.types,
        attributes: {
          fontSize: {
            default: null,
            parseHTML: (el: HTMLElement) => {
              const fs = el.style?.fontSize?.trim();
              if (!fs) return null;
              return fs;
            },
            renderHTML: (attrs) => {
              if (!attrs.fontSize) {
                return {};
              }
              return { style: `font-size: ${attrs.fontSize}` };
            },
          },
        },
      },
    ];
  },

  addCommands() {
    return {
      setCmsFontSize:
        (size: string | null) =>
        ({ chain }) => {
          if (!size) {
            return chain().focus().setMark("textStyle", { fontSize: null }).removeEmptyTextStyle().run();
          }
          return chain().focus().setMark("textStyle", { fontSize: size }).run();
        },
    };
  },
});

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    setCmsFontSize: (size: string | null) => ReturnType;
  }
}
