/**
 * Center-crop to square then render exact 192×192 and 512×512 PNGs for PWA icons.
 */

export type PwaIconFiles = { file192: File; file512: File };

/**
 * Load image via createImageBitmap (releases memory in finally).
 * Center square: side = min(w,h), offset (sx, sy).
 */
export async function renderPwaIconsFromImageFile(source: File): Promise<PwaIconFiles> {
  const bitmap = await createImageBitmap(source);
  try {
    const w = bitmap.width;
    const h = bitmap.height;
    if (w < 1 || h < 1) {
      throw new Error("Invalid image dimensions");
    }
    const side = Math.min(w, h);
    const sx = (w - side) / 2;
    const sy = (h - side) / 2;

    const baseName = source.name.replace(/\.[^.]+$/, "") || "icon";

    const renderSize = (px: number): Promise<File> => {
      const canvas = document.createElement("canvas");
      canvas.width = px;
      canvas.height = px;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Canvas unsupported");
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, px, px);
      return new Promise((resolve, reject) => {
        canvas.toBlob(
          (blob) => {
            if (!blob) {
              reject(new Error("PNG export failed"));
              return;
            }
            resolve(
              new File([blob], `${baseName}-pwa-${px}.png`, {
                type: "image/png",
              }),
            );
          },
          "image/png",
          1,
        );
      });
    };

    const [file192, file512] = await Promise.all([renderSize(192), renderSize(512)]);
    return { file192, file512 };
  } finally {
    bitmap.close();
  }
}
