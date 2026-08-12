// ============================================================================
// Deep Merge Utility - 深度配置合并工具
// ============================================================================
// 解决ConfigProvider中浅层merge的局限性，提供完整的递归深度合并。
//
// 功能特性：
//   - 递归合并嵌套对象
//   - 数组合并策略（replace/merge/append）
//   - 保留原型链
//   - 空值处理（null/undefined策略）
//   - 循环引用检测
//
// 使用场景：
//   1. 远程配置与本地配置合并
//   2. 用户自定义配置覆盖默认值
//   3. API响应数据与缓存合并
//   4. 多环境配置继承
// ============================================================================

export type MergeStrategy = 'replace' | 'merge' | 'append';

export interface DeepMergeOptions {
  /** 数组合并策略
   * - replace: 完全替换（默认）
   * - merge: 按索引合并（保留长度较长的数组）
   * - append: 追加（去重）
   */
  arrayStrategy?: MergeStrategy;
  
  /** 如何处理null值
   * - keep: 保留null，不覆盖目标值
   * - overwrite: null会覆盖目标值（默认）
   */
  nullStrategy?: 'keep' | 'overwrite';
  
  /** 如何处理undefined值
   * - skip: 跳过undefined，不覆盖目标值（默认）
   * - overwrite: undefined会覆盖目标值
   */
  undefinedStrategy?: 'skip' | 'overwrite';
  
  /** 是否克隆对象（避免引用污染）*/
  clone?: boolean;
  
  /** 自定义合并函数（优先级最高）*/
  customMerge?: <T>(target: T, source: T, key: string) => T | undefined;
}

const DEFAULT_OPTIONS: Required<DeepMergeOptions> = {
  arrayStrategy: 'replace',
  nullStrategy: 'overwrite',
  undefinedStrategy: 'skip',
  clone: true,
  customMerge: () => undefined,
};

/**
 * 检查是否为普通对象（排除Date、RegExp等特殊对象）
 */
function isPlainObject(val: unknown): val is Record<string, unknown> {
  if (typeof val !== 'object' || val === null) return false;
  const proto = Object.getPrototypeOf(val);
  return proto === null || proto === Object.prototype;
}

/**
 * 深度克隆（简化版，不处理循环引用）
 */
function deepClone<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(deepClone) as unknown as T;
  if (isPlainObject(obj)) {
    const cloned: Record<string, unknown> = {};
    for (const key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        cloned[key] = deepClone((obj as Record<string, unknown>)[key]);
      }
    }
    return cloned as T;
  }
  // Date, RegExp等直接返回新实例
  if (obj instanceof Date) return new Date(obj) as unknown as T;
  if (obj instanceof RegExp) return new RegExp(obj) as unknown as T;
  return obj;
}

/**
 * 数组合并
 */
function mergeArrays<T>(
  target: T[],
  source: T[],
  strategy: MergeStrategy,
  options: Required<DeepMergeOptions>
): T[] {
  switch (strategy) {
    case 'replace':
      return options.clone ? deepClone(source) : source;
    
    case 'merge': {
      // 按索引合并，保留较长数组的元素
      const maxLen = Math.max(target.length, source.length);
      const result: T[] = [];
      for (let i = 0; i < maxLen; i++) {
        if (i < source.length) {
          // source有此索引
          if (i < target.length && isPlainObject(target[i]) && isPlainObject(source[i])) {
            // 两者都是对象，递归合并
            result[i] = deepMergeInternal(
              target[i] as Record<string, unknown>,
              source[i] as Record<string, unknown>,
              options,
              new WeakMap()
            ) as T;
          } else {
            result[i] = options.clone ? deepClone(source[i]) : source[i];
          }
        } else {
          // source没有，保留target
          result[i] = options.clone ? deepClone(target[i]) : target[i];
        }
      }
      return result;
    }
    
    case 'append': {
      // 追加并去重（基于JSON序列化简单去重）
      const combined = [...target, ...source];
      const seen = new Set<string>();
      return combined.filter((item) => {
        const key = typeof item === 'object' ? JSON.stringify(item) : String(item);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
    
    default:
      return source;
  }
}

/**
 * 深度合并内部实现（支持循环引用检测）
 */
function deepMergeInternal<T extends Record<string, unknown>>(
  target: T,
  source: Partial<T>,
  options: Required<DeepMergeOptions>,
  visited: WeakMap<object, object>
): T {
  // 循环引用检测
  if (visited.has(source)) {
    return visited.get(source) as T;
  }

  const result = options.clone ? deepClone(target) : { ...target };
  visited.set(source, result);

  for (const key in source) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;

    const sourceValue = source[key];
    const targetValue = result[key];

    // 自定义合并函数优先
    const customResult = options.customMerge(targetValue, sourceValue, key);
    if (customResult !== undefined) {
      result[key] = customResult;
      continue;
    }

    // undefined策略
    if (sourceValue === undefined) {
      if (options.undefinedStrategy === 'skip') {
        continue; // 跳过，保留target值
      }
      result[key] = undefined as T[Extract<keyof T, string>];
      continue;
    }

    // null策略
    if (sourceValue === null) {
      if (options.nullStrategy === 'keep') {
        continue; // 保留target值
      }
      result[key] = null as T[Extract<keyof T, string>];
      continue;
    }

    // 数组合并
    if (Array.isArray(sourceValue)) {
      if (Array.isArray(targetValue)) {
        result[key] = mergeArrays(
          targetValue,
          sourceValue,
          options.arrayStrategy,
          options
        ) as T[Extract<keyof T, string>];
      } else {
        result[key] = (options.clone ? deepClone(sourceValue) : sourceValue) as T[Extract<keyof T, string>];
      }
      continue;
    }

    // 对象递归合并
    if (isPlainObject(sourceValue)) {
      if (isPlainObject(targetValue)) {
        result[key] = deepMergeInternal(
          targetValue as Record<string, unknown>,
          sourceValue as Record<string, unknown>,
          options,
          visited
        ) as T[Extract<keyof T, string>];
      } else {
        result[key] = (options.clone ? deepClone(sourceValue) : sourceValue) as T[Extract<keyof T, string>];
      }
      continue;
    }

    // 基本类型直接覆盖
    result[key] = (options.clone ? deepClone(sourceValue) : sourceValue) as T[Extract<keyof T, string>];
  }

  return result;
}

/**
 * 深度合并两个对���
 * 
 * @param target - 目标对象（默认值）
 * @param source - 源对象（覆盖值）
 * @param options - 合并选项
 * @returns 合并后的新对象
 * 
 * @example
 * ```ts
 * const defaults = {
 *   app: { name: 'TaprootAgro', theme: 'emerald' },
 *   features: ['market', 'ai'],
 *   limits: { max: 100 }
 * };
 * 
 * const custom = {
 *   app: { theme: 'blue' },
 *   features: ['weather'],
 *   limits: { min: 10 }
 * };
 * 
 * const merged = deepMerge(defaults, custom, { arrayStrategy: 'append' });
 * // {
 * //   app: { name: 'TaprootAgro', theme: 'blue' },
 * //   features: ['market', 'ai', 'weather'],
 * //   limits: { max: 100, min: 10 }
 * // }
 * ```
 */
export function deepMerge<T extends Record<string, unknown>>(
  target: T,
  source: Partial<T>,
  options: DeepMergeOptions = {}
): T {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  return deepMergeInternal(target, source, opts, new WeakMap());
}

/**
 * 合并多个对象（从左到右，后面的覆盖前面的）
 * 
 * @example
 * ```ts
 * const merged = deepMergeAll([defaults, env, user], { arrayStrategy: 'append' });
 * ```
 */
export function deepMergeAll<T extends Record<string, unknown>>(
  objects: Array<Partial<T>>,
  options: DeepMergeOptions = {}
): T {
  if (objects.length === 0) return {} as T;
  if (objects.length === 1) return objects[0] as T;
  
  return objects.reduce((acc, obj) => {
    return deepMerge(acc as T, obj, options);
  }, {} as T);
}

/**
 * 策略预设：完全替换模式（数组也替换）
 */
export const MERGE_REPLACE: DeepMergeOptions = {
  arrayStrategy: 'replace',
  clone: true,
};

/**
 * 策略预设：深度合并模式（数组按索引合并）
 */
export const MERGE_DEEP: DeepMergeOptions = {
  arrayStrategy: 'merge',
  clone: true,
};

/**
 * 策略预设：追加模式（数组追加去重）
 */
export const MERGE_APPEND: DeepMergeOptions = {
  arrayStrategy: 'append',
  clone: true,
};

/**
 * 策略预设：保守模式（保留null，跳过undefined）
 */
export const MERGE_CONSERVATIVE: DeepMergeOptions = {
  arrayStrategy: 'replace',
  nullStrategy: 'keep',
  undefinedStrategy: 'skip',
  clone: true,
};
