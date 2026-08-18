/**
 * imageUtils — Base64 / File / Blob 图片转换工具
 *
 * 用于 CameraOverlay 拍照后将 canvas 数据转为可发送的格式。
 */

/**
 * 将 base64 数据 URL 转为 File 对象
 */
export function base64ToFile(base64: string, filename: string = 'photo.jpg'): File {
  const arr = base64.split(',');
  const mime = arr[0].match(/:(.*?);/)?.[1] || 'image/jpeg';
  const bstr = atob(arr[1]);
  let n = bstr.length;
  const u8arr = new Uint8Array(n);
  while (n--) {
    u8arr[n] = bstr.charCodeAt(n);
  }
  return new File([u8arr], filename, { type: mime });
}

/**
 * 将 base64 数据 URL 转为 Blob
 */
export function base64ToBlob(base64: string): Blob {
  const arr = base64.split(',');
  const mime = arr[0].match(/:(.*?);/)?.[1] || 'image/jpeg';
  const bstr = atob(arr[1]);
  let n = bstr.length;
  const u8arr = new Uint8Array(n);
  while (n--) {
    u8arr[n] = bstr.charCodeAt(n);
  }
  return new Blob([u8arr], { type: mime });
}

/**
 * 将 File/Blob 转为 base64 数据 URL
 */
export function fileToBase64(file: File | Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/**
 * 从 canvas 捕获 base64 图片
 * @param canvas HTMLCanvasElement
 * @param quality JPEG 质量 0-1，默认 0.85
 */
export function canvasToBase64(canvas: HTMLCanvasElement, quality: number = 0.85): string {
  return canvas.toDataURL('image/jpeg', quality);
}
