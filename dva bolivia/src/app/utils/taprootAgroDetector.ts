/**
 * TaprootAgro ONNX 推理引擎（带 IndexedDB 智能缓存）
 *
 * 缓存策略：
 *   - 首次加载远程模型后，模型 ArrayBuffer + 标签 JSON 存入 IndexedDB
 *   - 每天第一次打开时，HEAD 请求检查 ETag / Last-Modified / Content-Length
 *   - 版本一致 → 直接用本地缓存（零网络流量）
 *   - 版本不一致 → 重新下载并更新缓存
 *   - 离线 → 如有缓存则使用缓存，否则 fallback 到演示模式
 *
 * 支持两种 ONNX 输出格式：
 * - 检测模式：输出 [1, 4+nc, 8400]，自动做 NMS
 * - 分类模式：输出 [1, nc]，直接取 topK
 *
 * ONNX Runtime 从 CDN 按需加载，不打包进构建产物（~24MB WASM）
 */

// ===== CDN 动态加载 ONNX Runtime =====
const ORT_CDN_VERSION = '1.21.0';
const ORT_CDN_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_CDN_VERSION}/dist`;
const ORT_CDN_JS = `${ORT_CDN_BASE}/ort.min.js`;

// 全局类型声明
declare global {
  interface Window { ort?: any; }
}

type OrtModule = {
  env: { wasm: { numThreads: number; wasmPaths: string } };
  InferenceSession: {
    create(path: string | ArrayBuffer, opts: any): Promise<any>;
  };
  Tensor: new (type: string, data: Float32Array, dims: number[]) => any;
};

let ortLoadPromise: Promise<OrtModule> | null = null;

async function loadOrt(): Promise<OrtModule> {
  if (window.ort) return window.ort as OrtModule;

  if (!ortLoadPromise) {
    ortLoadPromise = new Promise<OrtModule>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = ORT_CDN_JS;
      script.async = true;
      script.onload = () => {
        if (window.ort) {
          window.ort.env.wasm.wasmPaths = `${ORT_CDN_BASE}/`;
          resolve(window.ort as OrtModule);
        } else {
          reject(new Error('ONNX Runtime loaded but window.ort is undefined'));
        }
      };
      script.onerror = () => {
        ortLoadPromise = null;
        reject(new Error('Failed to load ONNX Runtime from CDN'));
      };
      document.head.appendChild(script);
    });
  }

  return ortLoadPromise;
}

// ===== 配置 =====
const DEFAULT_MODEL_PATH = '/models/taprootagro.onnx';
const DEFAULT_LABELS_PATH = '/models/labels.json';
const INPUT_SIZE = 640;
const CONF_THRESHOLD = 0.25;
const IOU_THRESHOLD = 0.45;
const MAX_DETECTIONS = 20;

// ===== IndexedDB 模型缓存 =====
const IDB_NAME = 'taproot-model-cache';
const IDB_VERSION = 1;
const IDB_STORE = 'models';

interface CachedModelMeta {
  modelUrl: string;
  labelsUrl: string;
  etag: string;
  lastModified: string;
  contentLength: string;
  lastCheckDate: string;    // "2026-03-01" 格式
  modelBuffer: ArrayBuffer;
  labelsJson: string;       // JSON.stringify(labels)
  cachedAt: number;         // Date.now()
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE, { keyPath: 'modelUrl' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getCachedModel(modelUrl: string): Promise<CachedModelMeta | null> {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const store = tx.objectStore(IDB_STORE);
      const req = store.get(modelUrl);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function saveCachedModel(meta: CachedModelMeta): Promise<void> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      const store = tx.objectStore(IDB_STORE);
      const req = store.put(meta);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    console.warn('[TaprootAgro-Cache] Failed to save to IndexedDB:', e);
  }
}

async function updateCheckDate(modelUrl: string): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(IDB_STORE, 'readwrite');
    const store = tx.objectStore(IDB_STORE);
    const req = store.get(modelUrl);
    req.onsuccess = () => {
      if (req.result) {
        req.result.lastCheckDate = getTodayStr();
        store.put(req.result);
      }
    };
  } catch { /* ignore */ }
}

function getTodayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

// ===== 接口 =====
export interface Detection {
  className: string;
  score: number;
  bbox: [number, number, number, number]; // [x1, y1, x2, y2] 归一化坐标 0-1
}

export interface TaprootAgroConfig {
  modelUrl?: string;
  labelsUrl?: string;
}

// ===== 检测器 =====
export class TaprootAgroDetector {
  private session: any = null;
  private ort: OrtModule | null = null;
  private labels: string[] = [];
  private _isLoaded = false;
  private _mode: 'detect' | 'classify' = 'detect';
  private onProgress?: (progress: number, status: string) => void;
  private config: TaprootAgroConfig;

  constructor(config?: TaprootAgroConfig) {
    this.config = config || {};
  }

  setProgressCallback(cb: (progress: number, status: string) => void) {
    this.onProgress = cb;
  }

  private getModelPath(): string {
    const url = this.config.modelUrl;
    return (url && url.length > 0) ? url : DEFAULT_MODEL_PATH;
  }

  private getLabelsPath(): string {
    const url = this.config.labelsUrl;
    return (url && url.length > 0) ? url : DEFAULT_LABELS_PATH;
  }

  private isRemoteUrl(url: string): boolean {
    return url.startsWith('http://') || url.startsWith('https://');
  }

  /**
   * 智能加载模型：IndexedDB 缓存 + 每日版本检查
   */
  async loadModel(): Promise<void> {
    const modelPath = this.getModelPath();
    const labelsPath = this.getLabelsPath();
    const isRemote = this.isRemoteUrl(modelPath);

    try {
      this.onProgress?.(5, 'Checking model...');

      // ===== 远程模型：走缓存策略 =====
      if (isRemote) {
        const cached = await getCachedModel(modelPath);

        if (cached) {
          const alreadyCheckedToday = cached.lastCheckDate === getTodayStr();

          if (alreadyCheckedToday) {
            // 今天已检查过，直接用缓存
            console.log('[TaprootAgro] Using cached model (already checked today)');
            this.onProgress?.(15, 'Loading cached model...');
            return await this.loadFromCache(cached);
          }

          // 今天第一次：HEAD 检查远程版本
          this.onProgress?.(10, 'Checking for model updates...');
          const versionChanged = await this.checkVersionChanged(modelPath, cached);

          if (!versionChanged) {
            // 版本一致，更新检查日期，用缓存
            console.log('[TaprootAgro] Remote model unchanged, using cache');
            await updateCheckDate(modelPath);
            this.onProgress?.(15, 'Loading cached model...');
            return await this.loadFromCache(cached);
          }

          // 版本变了，重新下载
          console.log('[TaprootAgro] Remote model updated, re-downloading...');
          this.onProgress?.(15, 'Model updated, downloading...');
        }

        // 无缓存 或 版本已更新 → 全量下载并缓存
        return await this.downloadAndCache(modelPath, labelsPath);
      }

      // ===== 本地模型：原有逻辑 =====
      this.onProgress?.(5, 'Checking model file...');
      const checkResp = await fetch(modelPath, { method: 'HEAD' });
      const contentType = checkResp.headers.get('content-type') || '';
      if (!checkResp.ok || contentType.includes('text/html')) {
        throw new Error('MODEL_NOT_FOUND');
      }

      // 加载标签
      this.onProgress?.(10, 'Loading labels...');
      await this.loadLabels(labelsPath);

      // 加载 ORT + 模型
      this.onProgress?.(20, 'Loading ONNX Runtime from CDN...');
      this.ort = await loadOrt();
      this.ort.env.wasm.numThreads = 1;

      this.onProgress?.(40, 'Loading model...');
      this.session = await this.ort.InferenceSession.create(modelPath, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      });

      this.finalizeLoad();
    } catch (error: any) {
      this._isLoaded = false;

      // 离线时尝试用缓存
      if (isRemote && (error?.message?.includes('Failed to fetch') || error?.message?.includes('NetworkError') || error?.name === 'TypeError')) {
        console.log('[TaprootAgro] Network error, trying offline cache...');
        const cached = await getCachedModel(modelPath);
        if (cached) {
          this.onProgress?.(15, 'Offline - loading cached model...');
          try {
            await this.loadFromCache(cached);
            return;
          } catch (cacheErr) {
            console.warn('[TaprootAgro] Cache fallback also failed:', cacheErr);
          }
        }
      }

      const msg = error?.message || String(error);
      if (msg.includes('MODEL_NOT_FOUND')) {
        console.log('[TaprootAgro] No model file found at', modelPath);
      } else {
        console.warn('[TaprootAgro] Model load failed:', error);
      }
      throw error;
    }
  }

  /**
   * HEAD 检查远程版本是否变化
   * 比较 ETag / Last-Modified / Content-Length
   * 网络错误时返回 false（视为未变化，用缓存）
   */
  private async checkVersionChanged(modelUrl: string, cached: CachedModelMeta): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      const resp = await fetch(modelUrl, {
        method: 'HEAD',
        mode: 'cors',
        signal: controller.signal,
        cache: 'no-store',
      });
      clearTimeout(timeoutId);

      if (!resp.ok) {
        // 服务器出错，保守使用缓存
        return false;
      }

      const remoteEtag = resp.headers.get('etag') || '';
      const remoteLastModified = resp.headers.get('last-modified') || '';
      const remoteContentLength = resp.headers.get('content-length') || '';

      // 有 ETag → 比较 ETag
      if (remoteEtag && cached.etag) {
        return remoteEtag !== cached.etag;
      }
      // 有 Last-Modified → 比较 Last-Modified
      if (remoteLastModified && cached.lastModified) {
        return remoteLastModified !== cached.lastModified;
      }
      // 都没有 → 比较 Content-Length（粗略）
      if (remoteContentLength && cached.contentLength) {
        return remoteContentLength !== cached.contentLength;
      }

      // 服务器不返回任何版本标识，保守不更新
      return false;
    } catch (err) {
      // 网络错误（离线等），保守使用缓存
      console.warn('[TaprootAgro] Version check failed (network), using cache:', err);
      await updateCheckDate(this.getModelPath());
      return false;
    }
  }

  /**
   * 从 IndexedDB 缓存加载模型
   */
  private async loadFromCache(cached: CachedModelMeta): Promise<void> {
    // 加载标签
    if (cached.labelsJson) {
      try {
        this.labels = JSON.parse(cached.labelsJson);
      } catch {
        this.labels = [];
      }
    }

    // 加载 ORT
    this.onProgress?.(30, 'Loading ONNX Runtime...');
    this.ort = await loadOrt();
    this.ort.env.wasm.numThreads = 1;

    // 从 ArrayBuffer 创建 session
    this.onProgress?.(50, 'Loading model from cache...');
    this.session = await this.ort.InferenceSession.create(cached.modelBuffer, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });

    this.finalizeLoad();
    console.log(`[TaprootAgro] Loaded from cache | ${this.labels.length} classes | cached ${new Date(cached.cachedAt).toLocaleDateString()}`);
  }

  /**
   * 下载远程模型 + 标签，存入 IndexedDB
   */
  private async downloadAndCache(modelUrl: string, labelsUrl: string): Promise<void> {
    // 1. 下载标签
    this.onProgress?.(10, 'Downloading labels...');
    let labelsJson = '[]';
    await this.loadLabels(labelsUrl);
    if (this.labels.length > 0) {
      labelsJson = JSON.stringify(this.labels);
    }

    // 2. 加载 ORT
    this.onProgress?.(20, 'Loading ONNX Runtime from CDN...');
    this.ort = await loadOrt();
    this.ort.env.wasm.numThreads = 1;

    // 3. 下载模型（获取 ArrayBuffer + 响应头）
    this.onProgress?.(30, 'Downloading model...');
    const resp = await fetch(modelUrl, { mode: 'cors', cache: 'no-store' });
    if (!resp.ok) {
      throw new Error('MODEL_NOT_FOUND');
    }

    const etag = resp.headers.get('etag') || '';
    const lastModified = resp.headers.get('last-modified') || '';
    const contentLength = resp.headers.get('content-length') || '';

    const modelBuffer = await resp.arrayBuffer();
    this.onProgress?.(70, 'Initializing model...');

    // 4. 从 ArrayBuffer 创建 session
    this.session = await this.ort.InferenceSession.create(modelBuffer, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });

    this.finalizeLoad();

    // 5. 异步存入 IndexedDB（不阻塞UI）
    this.onProgress?.(95, 'Caching model...');
    const meta: CachedModelMeta = {
      modelUrl,
      labelsUrl,
      etag,
      lastModified,
      contentLength,
      lastCheckDate: getTodayStr(),
      modelBuffer,
      labelsJson,
      cachedAt: Date.now(),
    };

    saveCachedModel(meta).then(() => {
      console.log(`[TaprootAgro] Model cached to IndexedDB | ${(modelBuffer.byteLength / 1024 / 1024).toFixed(1)}MB`);
    }).catch((e) => {
      console.warn('[TaprootAgro] Failed to cache model:', e);
    });
  }

  /** 加载标签文件 */
  private async loadLabels(labelsPath: string): Promise<void> {
    try {
      const resp = await fetch(labelsPath);
      if (resp.ok) {
        this.labels = await resp.json();
      }
    } catch {
      console.warn('[TaprootAgro] labels.json not found, will use numeric class IDs');
    }
  }

  /** 完成加载的共有逻辑 */
  private finalizeLoad(): void {
    const outputNames = this.session.outputNames;
    console.log('[TaprootAgro] Output nodes:', outputNames);
    this._isLoaded = true;
    this.onProgress?.(100, 'Ready');
    console.log(`[TaprootAgro] Model loaded | ${this.labels.length} classes`);
  }

  async detect(image: HTMLImageElement | HTMLCanvasElement): Promise<Detection[]> {
    if (!this._isLoaded || !this.session) throw new Error('Model not loaded');

    const input = this.preprocess(image);
    const inputName = this.session.inputNames[0];
    const tensor = new this.ort!.Tensor('float32', input.data, [1, 3, INPUT_SIZE, INPUT_SIZE]);
    const results = await this.session.run({ [inputName]: tensor });

    const outputName = this.session.outputNames[0];
    const output = results[outputName];
    const shape = output.dims;
    const data = output.data as Float32Array;

    console.log('[TaprootAgro] Output shape:', shape);

    if (shape.length === 3 && shape[2]! > shape[1]!) {
      this._mode = 'detect';
      return this.postprocessDetection(data, shape as number[], input.scale, input.padX, input.padY);
    } else if (shape.length === 2 || (shape.length === 3 && shape[2]! <= shape[1]!)) {
      this._mode = 'classify';
      return this.postprocessClassification(data);
    } else {
      console.warn('[TaprootAgro] Unknown output format, trying detection mode');
      return this.postprocessDetection(data, shape as number[], input.scale, input.padX, input.padY);
    }
  }

  /** 图像预处理：letterbox resize + CHW + normalize */
  private preprocess(image: HTMLImageElement | HTMLCanvasElement) {
    const srcW = image instanceof HTMLImageElement ? (image.naturalWidth || image.width) : image.width;
    const srcH = image instanceof HTMLImageElement ? (image.naturalHeight || image.height) : image.height;

    const scale = Math.min(INPUT_SIZE / srcW, INPUT_SIZE / srcH);
    const newW = Math.round(srcW * scale);
    const newH = Math.round(srcH * scale);
    const padX = (INPUT_SIZE - newW) / 2;
    const padY = (INPUT_SIZE - newH) / 2;

    const canvas = document.createElement('canvas');
    canvas.width = INPUT_SIZE;
    canvas.height = INPUT_SIZE;
    const ctx = canvas.getContext('2d')!;

    ctx.fillStyle = '#727272';
    ctx.fillRect(0, 0, INPUT_SIZE, INPUT_SIZE);
    ctx.drawImage(image, padX, padY, newW, newH);

    const imgData = ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE);
    const pixels = imgData.data;

    const floatData = new Float32Array(3 * INPUT_SIZE * INPUT_SIZE);
    const area = INPUT_SIZE * INPUT_SIZE;
    for (let i = 0; i < area; i++) {
      floatData[i]            = pixels[i * 4]     / 255;
      floatData[i + area]     = pixels[i * 4 + 1] / 255;
      floatData[i + area * 2] = pixels[i * 4 + 2] / 255;
    }

    return { data: floatData, scale, padX, padY };
  }

  /** 检测后处理：解码 + NMS */
  private postprocessDetection(
    data: Float32Array,
    shape: number[],
    scale: number,
    padX: number,
    padY: number
  ): Detection[] {
    const [_, rows, cols] = shape;
    const nc = rows - 4;

    if (nc <= 0) return [];
    this.ensureLabels(nc);

    const candidates: Detection[] = [];

    for (let i = 0; i < cols; i++) {
      const cx = data[0 * cols + i];
      const cy = data[1 * cols + i];
      const w  = data[2 * cols + i];
      const h  = data[3 * cols + i];

      let maxScore = 0;
      let maxIdx = 0;
      for (let c = 0; c < nc; c++) {
        const score = data[(4 + c) * cols + i];
        if (score > maxScore) {
          maxScore = score;
          maxIdx = c;
        }
      }

      if (maxScore < CONF_THRESHOLD) continue;

      const x1 = (cx - w / 2 - padX) / (INPUT_SIZE - 2 * padX);
      const y1 = (cy - h / 2 - padY) / (INPUT_SIZE - 2 * padY);
      const x2 = (cx + w / 2 - padX) / (INPUT_SIZE - 2 * padX);
      const y2 = (cy + h / 2 - padY) / (INPUT_SIZE - 2 * padY);

      candidates.push({
        className: this.labels[maxIdx] || `Class ${maxIdx}`,
        score: maxScore,
        bbox: [
          Math.max(0, Math.min(1, x1)),
          Math.max(0, Math.min(1, y1)),
          Math.max(0, Math.min(1, x2)),
          Math.max(0, Math.min(1, y2)),
        ],
      });
    }

    candidates.sort((a, b) => b.score - a.score);
    return this.nms(candidates).slice(0, MAX_DETECTIONS);
  }

  /** 分类后处理 */
  private postprocessClassification(data: Float32Array): Detection[] {
    const nc = data.length;
    this.ensureLabels(nc);

    const indexed = Array.from(data).map((score, i) => ({ score, i }));
    indexed.sort((a, b) => b.score - a.score);

    return indexed
      .slice(0, 5)
      .filter(x => x.score > 0.01)
      .map(x => ({
        className: this.labels[x.i] || `Class ${x.i}`,
        score: x.score,
        bbox: [0, 0, 1, 1] as [number, number, number, number],
      }));
  }

  /** NMS */
  private nms(boxes: Detection[]): Detection[] {
    const kept: Detection[] = [];
    const used = new Set<number>();

    for (let i = 0; i < boxes.length; i++) {
      if (used.has(i)) continue;
      kept.push(boxes[i]);

      for (let j = i + 1; j < boxes.length; j++) {
        if (used.has(j)) continue;
        if (this.iou(boxes[i].bbox, boxes[j].bbox) > IOU_THRESHOLD) {
          used.add(j);
        }
      }
    }
    return kept;
  }

  /** IoU 计算 */
  private iou(a: number[], b: number[]): number {
    const x1 = Math.max(a[0], b[0]);
    const y1 = Math.max(a[1], b[1]);
    const x2 = Math.min(a[2], b[2]);
    const y2 = Math.min(a[3], b[3]);
    const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    const areaA = (a[2] - a[0]) * (a[3] - a[1]);
    const areaB = (b[2] - b[0]) * (b[3] - b[1]);
    return inter / (areaA + areaB - inter + 1e-6);
  }

  /** 确保标签数组够用 */
  private ensureLabels(nc: number) {
    while (this.labels.length < nc) {
      this.labels.push(`Class ${this.labels.length}`);
    }
  }

  isLoaded() { return this._isLoaded; }
  getMode() { return this._mode; }
  getLabels() { return [...this.labels]; }
}
