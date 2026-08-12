import { useCallback, type CSSProperties, type PointerEvent } from "react";
import { NodeViewWrapper } from "@tiptap/react";
import type { NodeViewProps } from "@tiptap/core";
import { useCmsMediaUrl } from "../hooks/useCmsMediaUrl";

type CmsImageAlign = "left" | "center" | "right";

function buildWrapStyle(width: string | null, dataAlign: CmsImageAlign | null): CSSProperties {
  const al: CmsImageAlign = dataAlign || "center";
  const w = width?.trim() || null;
  const base: CSSProperties = { position: "relative", boxSizing: "border-box" };
  if (al === "left") {
    return {
      ...base,
      float: "left",
      margin: "8px 12px 8px 0",
      width: w || "50%",
      maxWidth: "50%",
    };
  }
  if (al === "right") {
    return {
      ...base,
      float: "right",
      margin: "8px 0 8px 12px",
      width: w || "50%",
      maxWidth: "50%",
    };
  }
  return {
    ...base,
    display: "block",
    margin: "8px auto",
    float: "none",
    clear: "both",
    width: w || "100%",
    maxWidth: "100%",
  };
}

const imgInWrap: CSSProperties = {
  display: "block",
  width: "100%",
  height: "auto",
  objectFit: "contain",
  borderRadius: 8,
  boxSizing: "border-box",
};

export function CmsImageView({ node, updateAttributes, selected }: NodeViewProps) {
  const { resolve } = useCmsMediaUrl();
  const { src, alt, title, width, dataAlign } = node.attrs as {
    src: string | null;
    alt: string | null;
    title: string | null;
    width: string | null;
    dataAlign: CmsImageAlign | null;
  };
  const al = (dataAlign || "center") as CmsImageAlign;

  const onPointerDownHandle = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      e.stopPropagation();
      e.preventDefault();
      const target = e.currentTarget as HTMLDivElement;
      const wrap = target.parentElement;
      if (!wrap) return;
      const parent = wrap.parentElement;
      if (!parent) return;
      try {
        target.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      const st = {
        startX: e.clientX,
        startW: wrap.getBoundingClientRect().width,
        parentW: Math.max(1, parent.getBoundingClientRect().width),
      };
      const onMove = (ev: Event) => {
        const pe = ev as globalThis.PointerEvent;
        const dx = pe.clientX - st.startX;
        const next = Math.max(40, Math.min(st.parentW, st.startW + dx));
        const pct = (next / st.parentW) * 100;
        const rounded = Math.round(pct * 10) / 10;
        updateAttributes({ width: `${Math.min(100, Math.max(5, rounded))}%` });
      };
      const onUp = (ev: Event) => {
        const pe = ev as globalThis.PointerEvent;
        try {
          target.releasePointerCapture(pe.pointerId);
        } catch {
          /* ignore */
        }
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        document.removeEventListener("pointercancel", onUp);
      };
      document.addEventListener("pointermove", onMove, { passive: true });
      document.addEventListener("pointerup", onUp);
      document.addEventListener("pointercancel", onUp);
    },
    [updateAttributes],
  );

  if (!src) {
    return <NodeViewWrapper as="div" className="cms-image-node-view" data-invalid="1" />;
  }

  return (
    <NodeViewWrapper as="div" className="cms-image-node-view" style={buildWrapStyle(width, al)} data-align={al}>
      <img
        className="rich-content-img"
        src={resolve(src)}
        alt={alt || ""}
        title={title || undefined}
        style={imgInWrap}
        data-align={al}
        contentEditable={false}
        draggable={false}
        loading="lazy"
        decoding="async"
      />
      {selected && (
        <div
          role="presentation"
          className="cms-image-resize-handle"
          onPointerDown={onPointerDownHandle}
          contentEditable={false}
          title="Drag to resize"
        />
      )}
    </NodeViewWrapper>
  );
}
