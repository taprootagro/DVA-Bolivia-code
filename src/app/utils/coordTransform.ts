/**
 * 坐标系转换工具
 * 支持 WGS84 / GCJ02 / BD09 三套坐标系互转
 *
 * WGS84  — GPS原始坐标（Google Maps 国际、Apple Maps、Waze）
 * GCJ02  — 国测局偏移坐标（高德地图、腾讯地图）
 * BD09   — 百度二次偏移坐标（百度地图）
 */

const PI = Math.PI;
const X_PI = (PI * 3000.0) / 180.0;
const A = 6378245.0; // 长半轴
const EE = 0.00669342162296594323; // 偏心率平方

/** 判断是否在中国境外（粗略矩形） */
function outOfChina(lng: number, lat: number): boolean {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function transformLat(lng: number, lat: number): number {
  let ret =
    -100.0 +
    2.0 * lng +
    3.0 * lat +
    0.2 * lat * lat +
    0.1 * lng * lat +
    0.2 * Math.sqrt(Math.abs(lng));
  ret +=
    ((20.0 * Math.sin(6.0 * lng * PI) + 20.0 * Math.sin(2.0 * lng * PI)) *
      2.0) /
    3.0;
  ret +=
    ((20.0 * Math.sin(lat * PI) + 40.0 * Math.sin((lat / 3.0) * PI)) * 2.0) /
    3.0;
  ret +=
    ((160.0 * Math.sin((lat / 12.0) * PI) +
      320 * Math.sin((lat * PI) / 30.0)) *
      2.0) /
    3.0;
  return ret;
}

function transformLng(lng: number, lat: number): number {
  let ret =
    300.0 +
    lng +
    2.0 * lat +
    0.1 * lng * lng +
    0.1 * lng * lat +
    0.1 * Math.sqrt(Math.abs(lng));
  ret +=
    ((20.0 * Math.sin(6.0 * lng * PI) + 20.0 * Math.sin(2.0 * lng * PI)) *
      2.0) /
    3.0;
  ret +=
    ((20.0 * Math.sin(lng * PI) + 40.0 * Math.sin((lng / 3.0) * PI)) * 2.0) /
    3.0;
  ret +=
    ((150.0 * Math.sin((lng / 12.0) * PI) +
      300.0 * Math.sin((lng / 30.0) * PI)) *
      2.0) /
    3.0;
  return ret;
}

// ─── WGS84 → GCJ02 ───
export function wgs84ToGcj02(
  lng: number,
  lat: number
): [number, number] {
  if (outOfChina(lng, lat)) return [lng, lat];
  let dLat = transformLat(lng - 105.0, lat - 35.0);
  let dLng = transformLng(lng - 105.0, lat - 35.0);
  const radLat = (lat / 180.0) * PI;
  let magic = Math.sin(radLat);
  magic = 1 - EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((A * (1 - EE)) / (magic * sqrtMagic)) * PI);
  dLng = (dLng * 180.0) / ((A / sqrtMagic) * Math.cos(radLat) * PI);
  return [lng + dLng, lat + dLat];
}

// ─── GCJ02 → WGS84（逆向迭代，精度 <0.5m） ───
export function gcj02ToWgs84(
  lng: number,
  lat: number
): [number, number] {
  if (outOfChina(lng, lat)) return [lng, lat];
  let wLng = lng,
    wLat = lat;
  for (let i = 0; i < 5; i++) {
    const [gLng, gLat] = wgs84ToGcj02(wLng, wLat);
    wLng += lng - gLng;
    wLat += lat - gLat;
  }
  return [wLng, wLat];
}

// ─── GCJ02 → BD09 ───
export function gcj02ToBd09(
  lng: number,
  lat: number
): [number, number] {
  const z = Math.sqrt(lng * lng + lat * lat) + 0.00002 * Math.sin(lat * X_PI);
  const theta = Math.atan2(lat, lng) + 0.000003 * Math.cos(lng * X_PI);
  const bdLng = z * Math.cos(theta) + 0.0065;
  const bdLat = z * Math.sin(theta) + 0.006;
  return [bdLng, bdLat];
}

// ─── BD09 → GCJ02 ───
export function bd09ToGcj02(
  lng: number,
  lat: number
): [number, number] {
  const x = lng - 0.0065;
  const y = lat - 0.006;
  const z = Math.sqrt(x * x + y * y) - 0.00002 * Math.sin(y * X_PI);
  const theta = Math.atan2(y, x) - 0.000003 * Math.cos(x * X_PI);
  const gcjLng = z * Math.cos(theta);
  const gcjLat = z * Math.sin(theta);
  return [gcjLng, gcjLat];
}

// ─── WGS84 → BD09 ───
export function wgs84ToBd09(
  lng: number,
  lat: number
): [number, number] {
  const [gLng, gLat] = wgs84ToGcj02(lng, lat);
  return gcj02ToBd09(gLng, gLat);
}

// ─── BD09 → WGS84 ───
export function bd09ToWgs84(
  lng: number,
  lat: number
): [number, number] {
  const [gLng, gLat] = bd09ToGcj02(lng, lat);
  return gcj02ToWgs84(gLng, gLat);
}

// ─── 统一转换入口 ───
export type CoordSystem = "wgs84" | "gcj02" | "bd09";

/**
 * 将输入坐标从 `from` 坐标系转换到 `to` 坐标系
 * @returns [lng, lat]
 */
export function convertCoord(
  lng: number,
  lat: number,
  from: CoordSystem,
  to: CoordSystem
): [number, number] {
  if (from === to) return [lng, lat];

  // 先统一到 WGS84
  let wLng = lng,
    wLat = lat;
  if (from === "gcj02") {
    [wLng, wLat] = gcj02ToWgs84(lng, lat);
  } else if (from === "bd09") {
    [wLng, wLat] = bd09ToWgs84(lng, lat);
  }

  // 再从 WGS84 转到目标
  if (to === "wgs84") return [wLng, wLat];
  if (to === "gcj02") return wgs84ToGcj02(wLng, wLat);
  if (to === "bd09") return wgs84ToBd09(wLng, wLat);
  return [wLng, wLat];
}
