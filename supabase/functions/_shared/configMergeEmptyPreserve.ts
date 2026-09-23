/**
 * Merge incoming app_config JSON with the previous row.
 * Empty strings in the payload override previous non-empty values.
 */

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function mergeArrays(inc: unknown[], prev: unknown[]): unknown[] {
  const p = Array.isArray(prev) ? prev : [];
  return inc.map((item, i) => {
    let prevItem: unknown = p[i];
    if (isPlainObject(item)) {
      const id = item.id;
      if (id !== undefined && id !== null) {
        const found = p.find(
          (x) => isPlainObject(x) && String(x.id) === String(id),
        );
        if (found !== undefined) prevItem = found;
      }
    }
    return mergeValue(item, prevItem, "");
  });
}

function mergeValue(inc: unknown, prev: unknown, key: string): unknown {
  if (inc === undefined) {
    return prev !== undefined ? prev : inc;
  }
  if (prev === undefined || prev === null) {
    return inc;
  }
  if (Array.isArray(inc) && Array.isArray(prev)) {
    return mergeArrays(inc, prev);
  }
  if (isPlainObject(inc) && isPlainObject(prev)) {
    const out: Record<string, unknown> = { ...inc };
    for (const k of Object.keys(out)) {
      out[k] = mergeValue(out[k], prev[k], k);
    }
    return out;
  }
  return inc;
}

/**
 * @param incoming POST body config
 * @param previous existing DB config (null if first insert)
 */
export function mergeConfigPreserveEmptyMediaUrls(
  incoming: unknown,
  previous: unknown,
): unknown {
  if (previous === null || previous === undefined) {
    return incoming;
  }
  return mergeValue(incoming, previous, "");
}
