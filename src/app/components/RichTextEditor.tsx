import { useRef, useCallback, useEffect, useMemo, useState } from "react";
import type { Editor } from "@tiptap/core";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { TextAlign } from "@tiptap/extension-text-align";
import { Link } from "@tiptap/extension-link";
import { Placeholder } from "@tiptap/extension-placeholder";
import { Underline } from "@tiptap/extension-underline";
import { TextStyle } from "@tiptap/extension-text-style";
import { Color } from "@tiptap/extension-color";
import { Highlight } from "@tiptap/extension-highlight";
import { Youtube } from "@tiptap/extension-youtube";
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table-row";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import {
  Bold,
  Italic,
  Underline as UnderlineIcon,
  List,
  ListOrdered,
  ImagePlus,
  Loader2,
  Undo2,
  Redo2,
  RemoveFormatting,
  AlignLeft,
  AlignCenter,
  AlignRight,
  Code,
  Quote,
  Clapperboard,
  Highlighter,
} from "lucide-react";
import { useLanguage } from "../hooks/useLanguage";
import { createCmsTranslator, cmsText } from "../i18n/cmsTranslate";
import enTranslations from "../i18n/lang/en";
import { uploadFileToCmsPublic } from "../utils/cmsPublicUpload";
import { getServerUserId } from "../utils/auth";
import { CmsImage, type CmsImageAlign } from "./cmsTiptapImage";
import { CmsFontSize } from "./cmsTiptapFontSize";
import { CmsOEmbed } from "./cmsTiptapOEmbed";
import { getNonYoutubeEmbedUrl, isYoutubeUserUrl } from "../utils/videoEmbedFromUrl";
import {
  cleanWordHtml,
  convertDataImagesInHtmlToCms,
} from "../utils/richTextWordPaste";

const MAX_CMS_IMAGE_BYTES = 15 * 1024 * 1024;

const FONT_SIZE_OPTIONS = ["12px", "14px", "16px", "18px", "20px", "24px", "28px"] as const;

const DEFAULT_TEXT_SWATCH = "#1f2937";
const DEFAULT_HIGHLIGHT_SWATCH = "#fef08a";

function colorInputValue(raw: string | null | undefined): string {
  if (raw && /^#[0-9A-Fa-f]{6}$/.test(raw.trim())) return raw.trim();
  if (raw && /^#[0-9A-Fa-f]{3}$/.test(raw.trim())) return raw.trim();
  return DEFAULT_TEXT_SWATCH;
}

function normalizeEditorHtml(html: string): string {
  const t = html.trim();
  if (
    t === "<p></p>" ||
    t === '<p class="is-empty is-editor-empty"></p>' ||
    t === "<p><br></p>" ||
    t === '<p><br class="ProseMirror-trailingBreak"></p>' ||
    t ===
      '<p class="is-empty is-editor-empty"><br class="ProseMirror-trailingBreak"></p>'
  ) {
    return "";
  }
  return html;
}

export interface RichTextEditorProps {
  label: string;
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  minHeight?: string;
}

export function RichTextEditor({
  label,
  value,
  onChange,
  placeholder,
  minHeight = "200px",
}: RichTextEditorProps) {
  const { t, language } = useLanguage();
  const ct = createCmsTranslator(t, language, enTranslations);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const isEmittingRef = useRef(false);
  const editorRef = useRef<Editor | null>(null);
  const [imageUploadBusy, setImageUploadBusy] = useState(false);
  const [imageMsg, setImageMsg] = useState<string | null>(null);
  const languageRef = useRef(language);
  languageRef.current = language;

  const setUploadError = useCallback(
    (result: { ok: false; error: string; rlsDenied?: boolean }) => {
      if (result.rlsDenied) {
        setImageMsg(
          cmsText(t, languageRef.current, {
            key: "messages.upload_denied_content_super_admin",
            zh: "上传被拒绝：需要内容管理员权限。请在 Supabase 将 user_profiles.content_super_admin 设为 true 并重新登录。",
            en: "Upload denied: set content_super_admin for your user in Supabase, then sign in again.",
          }, enTranslations),
        );
        return;
      }
      setImageMsg(result.error);
    },
    [t],
  );

  const runUpload = useRef<(file: File) => void>(() => {});

  const placeholderText = placeholder ?? "";
  const extensions = useMemo(
    () => [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        codeBlock: true,
      }),
      Table.configure({ resizable: false }),
      TableRow,
      TableHeader,
      TableCell,
      CmsImage,
      TextAlign.configure({ types: ["heading", "paragraph"] }),
      Link.configure({
        openOnClick: false,
        autolink: true,
        defaultProtocol: "https",
        HTMLAttributes: { rel: "noopener noreferrer" },
      }),
      Underline,
      TextStyle.configure({ mergeNestedSpanStyles: true }),
      Color,
      CmsFontSize,
      Highlight.configure({ multicolor: true }),
      Youtube.configure({
        addPasteHandler: true,
        width: 640,
        height: 360,
        HTMLAttributes: { class: "rich-youtube-wrap" },
      }),
      CmsOEmbed,
      Placeholder.configure({
        placeholder: placeholderText,
        showOnlyWhenEditable: true,
        emptyNodeClass: "is-editor-empty",
      }),
    ],
    [placeholderText],
  );

  const editor = useEditor(
    {
      immediatelyRender: false,
      shouldRerenderOnTransaction: true,
      extensions,
      content: value || "",
      onCreate: ({ editor: ed }) => {
        editorRef.current = ed;
      },
      onDestroy: () => {
        editorRef.current = null;
      },
      editorProps: {
        attributes: { class: "prose-mirror-cms" },
        transformPastedHTML: (html) => cleanWordHtml(html, { stripDataImages: true }),
        handlePaste: (_view, e) => {
          const ev = e as ClipboardEvent;
          const html = ev.clipboardData?.getData("text/html") || "";
          if (html && /src=["']data:image/i.test(html)) {
            ev.preventDefault();
            void (async () => {
              setImageUploadBusy(true);
              if (!getServerUserId()) {
                setImageMsg(
                  cmsText(t, languageRef.current, {
                    key: "messages.sign_in_for_word_embedded_images",
                    zh: "未登录：已去掉 Word 内嵌图。登录后可自动上传内嵌图与保留图文。",
                    en: "Sign in to upload embedded Word images; images were removed from paste.",
                  }, enTranslations),
                );
                const cleaned = cleanWordHtml(html, { stripDataImages: true });
                editorRef.current?.chain().focus().insertContent(cleaned).run();
                setImageUploadBusy(false);
                return;
              }
              setImageMsg(
                cmsText(t, languageRef.current, {
                  key: "messages.uploading_embedded_images_from_word",
                  zh: "正在上传 Word 内嵌图片…",
                  en: "Uploading embedded images from Word…",
                }, enTranslations),
              );
              try {
                const out = await convertDataImagesInHtmlToCms(html);
                editorRef.current?.chain().focus().insertContent(out).run();
                setImageMsg(null);
              } catch (err) {
                setImageMsg(err instanceof Error ? err.message : String(err));
              } finally {
                setImageUploadBusy(false);
              }
            })();
            return true;
          }
          const items = ev.clipboardData?.items;
          if (!items) return false;
          for (let i = 0; i < items.length; i++) {
            if (items[i]!.type.startsWith("image/")) {
              ev.preventDefault();
              const f = items[i]!.getAsFile();
              if (f) runUpload.current(f);
              return true;
            }
          }
          return false;
        },
        handleDrop: (_view, e) => {
          const ev = e as DragEvent;
          const files = ev.dataTransfer?.files;
          if (!files?.length) return false;
          for (let i = 0; i < files.length; i++) {
            if (files[i]!.type.startsWith("image/")) {
              ev.preventDefault();
              runUpload.current(files[i]!);
              return true;
            }
          }
          return false;
        },
      },
      onUpdate: ({ editor: ed }) => {
        isEmittingRef.current = true;
        onChangeRef.current(normalizeEditorHtml(ed.getHTML()));
      },
    },
    [extensions],
  );

  const doUpload = useCallback(
    async (file: File) => {
      setImageMsg(null);
      if (!getServerUserId()) {
        setImageMsg(
          ct("messages.sign_in_before_inserting_images_server_account", "需要已登录服务器账号后再插入图片。", "Sign in before inserting images (server account)."),
        );
        return;
      }
      if (file.size > MAX_CMS_IMAGE_BYTES) {
        setImageMsg(
          ct(
            `图片过大（上限 ${MAX_CMS_IMAGE_BYTES / (1024 * 1024)}MB）`,
            `Image too large (max ${MAX_CMS_IMAGE_BYTES / (1024 * 1024)}MB)`,
          ),
        );
        return;
      }
      setImageUploadBusy(true);
      try {
        const result = await uploadFileToCmsPublic(file);
        if (!result.ok) {
          setUploadError(result);
          return;
        }
        const ed = editorRef.current;
        if (!ed) return;
        ed.chain().focus().setImage({ src: result.storagePath, dataAlign: "center" }).run();
      } catch (e) {
        setImageMsg(e instanceof Error ? e.message : String(e));
      } finally {
        setImageUploadBusy(false);
      }
    },
    [ct, setUploadError],
  );

  useEffect(() => {
    runUpload.current = (f) => {
      void doUpload(f);
    };
  }, [doUpload]);

  useEffect(() => {
    if (!editor) return;
    if (isEmittingRef.current) {
      isEmittingRef.current = false;
      return;
    }
    const next = value || "";
    if (next !== editor.getHTML()) {
      editor.commands.setContent(next, { emitUpdate: false });
    }
  }, [value, editor]);

  const insertImageFile = useCallback(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = () => {
      const f = input.files?.[0];
      if (f) void doUpload(f);
    };
    input.click();
  }, [doUpload]);

  const insertVideoFromUrl = useCallback(() => {
    if (!editor) return;
    const raw = window.prompt(
      ct("messages.paste_a_youtube_vimeo_or_bilibili_video_page", "粘贴 YouTube / Vimeo / B 站 / Facebook 视频页或分享链接", "Paste a YouTube, Vimeo, Bilibili, or Facebook video page URL"),
    );
    if (raw == null) return;
    const t = raw.trim();
    if (!t) return;
    setImageMsg(null);
    if (isYoutubeUserUrl(t)) {
      const ok = editor.commands.setYoutubeVideo({ src: t });
      if (!ok) {
        setImageMsg(
          ct("messages.could_not_parse_a_valid_youtube_url", "无法识别为有效的 YouTube 链接。", "Could not parse a valid YouTube URL."),
        );
      }
      return;
    }
    const embed = getNonYoutubeEmbedUrl(t);
    if (embed) {
      editor.chain().focus().setCmsOEmbed(embed).run();
      return;
    }
    setImageMsg(
      ct("messages.unsupported_url_use_a_youtube_vimeo_or_bilibili", "不支持的链接。请使用 YouTube、Vimeo、B 站或 Facebook 视频页链接。", "Unsupported URL. Use a YouTube, Vimeo, Bilibili, or Facebook video page link."),
    );
  }, [editor, ct]);

  const run = (fn: () => void) => {
    if (!editor) return;
    fn();
  };

  const imgActive = editor?.isActive("image") === true;
  const setImgAttr = (patch: { width?: string | null; dataAlign?: CmsImageAlign }) => {
    if (!editor || !imgActive) return;
    editor.chain().focus().updateAttributes("image", patch).run();
  };

  const ToolButton = (props: {
    onClick: () => void;
    title: string;
    children: React.ReactNode;
    className?: string;
    disabled?: boolean;
    active?: boolean;
  }) => (
    <button
      type="button"
      disabled={props.disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={props.onClick}
      title={props.title}
      className={`p-1.5 rounded hover:bg-gray-200 active:bg-gray-300 transition-colors text-gray-600 ${
        props.active ? "bg-gray-200" : ""
      } ${props.disabled ? "opacity-50 pointer-events-none" : ""} ${props.className ?? ""}`}
    >
      {props.children}
    </button>
  );

  if (!editor) {
    return (
      <div>
        <label className="block text-sm text-gray-700 mb-1">{label}</label>
        <div
          className="border border-gray-300 rounded-lg"
          style={{ minHeight: `calc(${minHeight} + 48px)` }}
          aria-hidden
        />
      </div>
    );
  }

  return (
    <div>
      <label className="block text-sm text-gray-700 mb-1">{label}</label>
      <div className="border border-gray-300 rounded-lg overflow-hidden focus-within:ring-2 focus-within:ring-emerald-500 focus-within:ring-inset focus-within:border-emerald-500 flex flex-col max-w-full min-h-0">
        <div className="relative z-20 flex flex-shrink-0 flex-wrap items-center gap-0.5 px-2 py-1.5 bg-gray-50 border-b border-gray-200">
          <ToolButton
            onClick={() => run(() => editor.chain().focus().toggleBold().run())}
            title="Bold"
            active={editor.isActive("bold")}
          >
            <Bold className="w-4 h-4" />
          </ToolButton>
          <ToolButton
            onClick={() => run(() => editor.chain().focus().toggleItalic().run())}
            title="Italic"
            active={editor.isActive("italic")}
          >
            <Italic className="w-4 h-4" />
          </ToolButton>
          <ToolButton
            onClick={() => run(() => editor.chain().focus().toggleUnderline().run())}
            title="Underline"
            active={editor.isActive("underline")}
          >
            <UnderlineIcon className="w-4 h-4" />
          </ToolButton>
          <select
            aria-label={ct("messages.font_size", "字号", "Font size")}
            className="text-xs border border-gray-300 rounded px-1 py-1 max-w-[6.5rem] bg-white text-gray-800"
            value={(editor.getAttributes("textStyle").fontSize as string) || ""}
            onChange={(ev) => {
              const v = ev.target.value;
              run(() => {
                editor.commands.setCmsFontSize(v || null);
              });
            }}
            onMouseDown={(e) => e.stopPropagation()}
            title={ct("messages.font_size", "字号", "Font size")}
          >
            <option value="">{ct("messages.default", "默认", "Default")}</option>
            {FONT_SIZE_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-0.5" title={ct("messages.text_color", "文字颜色", "Text color")}>
            <span className="sr-only">{ct("messages.text_color", "文字颜色", "Text color")}</span>
            <input
              type="color"
              className="h-7 w-8 p-0 border border-gray-300 rounded cursor-pointer bg-white"
              aria-label={ct("messages.text_color", "文字颜色", "Text color")}
              value={colorInputValue((editor.getAttributes("textStyle").color as string) || undefined)}
              onChange={(ev) => {
                run(() => editor.chain().focus().setColor(ev.target.value).run());
              }}
              onMouseDown={(e) => e.stopPropagation()}
            />
          </label>
          <ToolButton
            onClick={() => run(() => editor.chain().focus().unsetColor().run())}
            title={ct("messages.clear_text_color", "清除文字颜色", "Clear text color")}
          >
            <span className="text-[10px] font-semibold leading-none text-gray-500">A</span>
          </ToolButton>
          <label className="flex items-center gap-0.5" title={ct("messages.highlight", "高亮底色", "Highlight")}>
            <span className="sr-only">{ct("messages.highlight_color", "高亮颜色", "Highlight color")}</span>
            <input
              type="color"
              className="h-7 w-8 p-0 border border-gray-300 rounded cursor-pointer bg-white"
              aria-label={ct("messages.highlight_color", "高亮颜色", "Highlight color")}
              value={colorInputValue(
                (editor.getAttributes("highlight").color as string) || DEFAULT_HIGHLIGHT_SWATCH,
              )}
              onChange={(ev) => {
                const c = ev.target.value;
                run(() => editor.chain().focus().setHighlight({ color: c }).run());
              }}
              onMouseDown={(e) => e.stopPropagation()}
            />
          </label>
          <ToolButton
            onClick={() =>
              run(() => {
                if (editor.isActive("highlight")) {
                  editor.chain().focus().unsetHighlight().run();
                } else {
                  const c =
                    (editor.getAttributes("highlight").color as string) || DEFAULT_HIGHLIGHT_SWATCH;
                  editor.chain().focus().setHighlight({ color: c }).run();
                }
              })
            }
            title={ct("messages.toggle_highlight", "切换高亮", "Toggle highlight")}
            active={editor.isActive("highlight")}
          >
            <Highlighter className="w-4 h-4" />
          </ToolButton>
          <div className="w-px h-5 bg-gray-300 mx-1" />
          <select
            aria-label={ct("messages.paragraph_heading", "段落 / 标题", "Paragraph / heading")}
            className="text-xs border border-gray-300 rounded px-1 py-1 max-w-[7.5rem] bg-white text-gray-800"
            value={
              editor.isActive("heading", { level: 1 })
                ? "1"
                : editor.isActive("heading", { level: 2 })
                  ? "2"
                  : editor.isActive("heading", { level: 3 })
                    ? "3"
                    : "p"
            }
            onChange={(ev) => {
              const v = ev.target.value;
              run(() => {
                if (v === "p") {
                  editor.chain().focus().setParagraph().run();
                } else {
                  const level = Number(v) as 1 | 2 | 3;
                  editor.chain().focus().setHeading({ level }).run();
                }
              });
            }}
            onMouseDown={(e) => e.stopPropagation()}
            title={ct("messages.paragraph_headings", "段落与标题", "Paragraph & headings")}
          >
            <option value="p">{ct("messages.body", "正文", "Body")}</option>
            <option value="1">H1</option>
            <option value="2">H2</option>
            <option value="3">H3</option>
          </select>
          <div className="w-px h-5 bg-gray-300 mx-1" />
          <ToolButton
            onClick={() => run(() => editor.chain().focus().setTextAlign("left").run())}
            title="Align left"
            active={editor.isActive({ textAlign: "left" })}
          >
            <AlignLeft className="w-4 h-4" />
          </ToolButton>
          <ToolButton
            onClick={() => run(() => editor.chain().focus().setTextAlign("center").run())}
            title="Align center"
            active={editor.isActive({ textAlign: "center" })}
          >
            <AlignCenter className="w-4 h-4" />
          </ToolButton>
          <ToolButton
            onClick={() => run(() => editor.chain().focus().setTextAlign("right").run())}
            title="Align right"
            active={editor.isActive({ textAlign: "right" })}
          >
            <AlignRight className="w-4 h-4" />
          </ToolButton>
          <div className="w-px h-5 bg-gray-300 mx-1" />
          <ToolButton
            onClick={() => run(() => editor.chain().focus().toggleBulletList().run())}
            title="Bullet list"
            active={editor.isActive("bulletList")}
          >
            <List className="w-4 h-4" />
          </ToolButton>
          <ToolButton
            onClick={() => run(() => editor.chain().focus().toggleOrderedList().run())}
            title="Numbered list"
            active={editor.isActive("orderedList")}
          >
            <ListOrdered className="w-4 h-4" />
          </ToolButton>
          <div className="w-px h-5 bg-gray-300 mx-1" />
          <ToolButton
            onClick={() => run(() => editor.chain().focus().toggleBlockquote().run())}
            title={ct("messages.blockquote", "引用", "Blockquote")}
            active={editor.isActive("blockquote")}
          >
            <Quote className="w-4 h-4" />
          </ToolButton>
          <ToolButton
            onClick={() => run(() => editor.chain().focus().toggleCodeBlock().run())}
            title={ct("messages.code_block", "代码块", "Code block")}
            active={editor.isActive("codeBlock")}
          >
            <Code className="w-4 h-4" />
          </ToolButton>
          <div className="w-px h-5 bg-gray-300 mx-1" />
          <ToolButton
            onClick={insertVideoFromUrl}
            title={ct("messages.insert_video_youtube_vimeo_bilibili", "插入视频（YouTube / Vimeo / B 站 / Facebook）", "Insert video (YouTube, Vimeo, Bilibili, Facebook)")}
            disabled={imageUploadBusy}
          >
            <Clapperboard className="w-4 h-4" />
          </ToolButton>
          <div className="w-px h-5 bg-gray-300 mx-1" />
          <ToolButton
            onClick={insertImageFile}
            title={ct("messages.insert_image_upload_to_server", "插入图片（上传至服务器）", "Insert image (upload to server)")}
            disabled={imageUploadBusy}
          >
            {imageUploadBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ImagePlus className="w-4 h-4" />}
          </ToolButton>
          <div className="w-px h-5 bg-gray-300 mx-1" />
          <ToolButton
            onClick={() => setImgAttr({ width: "33%" })}
            title={ct("messages.image_width_33_row", "图片宽度 约 1/3 行", "Image width ~33% row")}
            disabled={!imgActive}
            active={imgActive}
          >
            <span className="text-[10px] font-bold px-0.5">S</span>
          </ToolButton>
          <ToolButton
            onClick={() => setImgAttr({ width: "50%" })}
            title={ct("messages.image_width_50_row", "图片宽度 约半行", "Image width ~50% row")}
            disabled={!imgActive}
            active={imgActive}
          >
            <span className="text-[10px] font-bold px-0.5">M</span>
          </ToolButton>
          <ToolButton
            onClick={() => setImgAttr({ width: "100%" })}
            title={ct("messages.image_full_row_width", "图片宽度 整行", "Image full row width")}
            disabled={!imgActive}
            active={imgActive}
          >
            <span className="text-[10px] font-bold px-0.5">L</span>
          </ToolButton>
          <div className="w-px h-5 bg-gray-300 mx-1" />
          <ToolButton
            onClick={() => setImgAttr({ dataAlign: "left" })}
            title={ct("messages.image_left_wrap", "图片居左/环绕", "Image left + wrap")}
            disabled={!imgActive}
            active={imgActive}
          >
            <AlignLeft className="w-4 h-4" />
          </ToolButton>
          <ToolButton
            onClick={() => setImgAttr({ dataAlign: "center" })}
            title={ct("messages.image_centered", "图片居中", "Image centered")}
            disabled={!imgActive}
            active={imgActive}
          >
            <AlignCenter className="w-4 h-4" />
          </ToolButton>
          <ToolButton
            onClick={() => setImgAttr({ dataAlign: "right" })}
            title={ct("messages.image_right_wrap", "图片居右/环绕", "Image right + wrap")}
            disabled={!imgActive}
            active={imgActive}
          >
            <AlignRight className="w-4 h-4" />
          </ToolButton>
          <div className="w-px h-5 bg-gray-300 mx-1" />
          <ToolButton onClick={() => run(() => editor.chain().focus().undo().run())} title="Undo">
            <Undo2 className="w-4 h-4" />
          </ToolButton>
          <ToolButton onClick={() => run(() => editor.chain().focus().redo().run())} title="Redo">
            <Redo2 className="w-4 h-4" />
          </ToolButton>
          <ToolButton
            onClick={() => run(() => editor.chain().focus().unsetAllMarks().run())}
            title="Clear inline formatting"
          >
            <RemoveFormatting className="w-4 h-4" />
          </ToolButton>
        </div>
        {imageMsg && (
          <p
            className={`px-2 py-1.5 text-xs ${
              imageMsg.includes("已移除") || imageMsg.includes("Embedded")
                ? "bg-amber-50 text-amber-900"
                : "bg-red-50 text-red-700"
            } border-b border-gray-100`}
            role="status"
          >
            {imageMsg}
          </p>
        )}
        <div
          className="relative z-0 w-full min-w-0 min-h-0 max-w-full max-h-[min(70vh,32rem)] overflow-x-hidden overflow-y-auto overscroll-contain bg-white rich-editor-tiptap"
          style={{ WebkitOverflowScrolling: "touch" }}
        >
          <EditorContent
            editor={editor}
            className="px-3 py-2 text-sm text-gray-800 rich-editor-content w-full min-h-0"
            style={{ minHeight }}
          />
        </div>
      </div>
    </div>
  );
}
