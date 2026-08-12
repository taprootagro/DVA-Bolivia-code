/**
 * 微信 JS-SDK 集成工具
 *
 * 使用流程：
 * 1. 后端提供签名接口（wxSignatureApi），接受 { url } 返回 { appId, timestamp, nonceStr, signature }
 * 2. 前端调用 initWxSdk → 注入 JS-SDK 脚本 → wx.config
 * 3. config 成功后调用 setupWxShare 设置自定义分享
 *
 * 注意：微信 JS-SDK 只能在微信内置浏览器中生效。
 */

declare global {
  interface Window {
    wx?: any;
  }
}

/** 检测是否在微信内置浏览器中 */
export function isWeChatBrowser(): boolean {
  const ua = navigator.userAgent.toLowerCase();
  return ua.includes("micromessenger");
}

/** 动态加载微信 JS-SDK（1.6.0） */
function loadWxScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.wx) {
      resolve();
      return;
    }
    const existing = document.getElementById("wx-jssdk-script");
    if (existing) {
      // 已经在加载中，等 onload
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("WX SDK script load failed")));
      return;
    }
    const script = document.createElement("script");
    script.id = "wx-jssdk-script";
    script.src = "https://res.wx.qq.com/open/js/jweixin-1.6.0.js";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("WX SDK script load failed"));
    document.head.appendChild(script);
  });
}

export interface WxSignatureResponse {
  appId: string;
  timestamp: number | string;
  nonceStr: string;
  signature: string;
}

export interface WxShareData {
  title: string;
  desc: string;
  link: string;
  imgUrl: string;
}

/**
 * 初始化微信 JS-SDK
 * @param signatureApiUrl 后端签名接口完整URL
 * @param jsApiList       需要使用的 JS-API 列表
 */
export async function initWxSdk(
  signatureApiUrl: string,
  jsApiList: string[] = [
    "updateAppMessageShareData",
    "updateTimelineShareData",
    "onMenuShareAppMessage",
    "onMenuShareTimeline",
  ]
): Promise<void> {
  if (!isWeChatBrowser()) {
    console.log("[WxJsSdk] 非微信浏览器，跳过初始化");
    return;
  }

  await loadWxScript();

  // 请求后端签名
  const currentUrl = window.location.href.split("#")[0]; // 微信要求不带 hash
  let sigData: WxSignatureResponse;
  try {
    const res = await fetch(signatureApiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: currentUrl }),
    });
    if (!res.ok) throw new Error(`Signature API ${res.status}`);
    sigData = await res.json();
  } catch (err) {
    console.error("[WxJsSdk] 签名接口请求失败:", err);
    throw err;
  }

  // wx.config
  return new Promise<void>((resolve, reject) => {
    window.wx.config({
      debug: false,
      appId: sigData.appId,
      timestamp: sigData.timestamp,
      nonceStr: sigData.nonceStr,
      signature: sigData.signature,
      jsApiList,
    });

    window.wx.ready(() => {
      console.log("[WxJsSdk] wx.config 成功");
      resolve();
    });

    window.wx.error((res: any) => {
      console.error("[WxJsSdk] wx.config 失败:", res);
      reject(new Error(res.errMsg || "wx.config error"));
    });
  });
}

/**
 * 设置微信自定义分享内容
 * 同时设置「分享给朋友」和「分享到朋友圈」
 */
export function setupWxShare(data: WxShareData): void {
  if (!window.wx || !isWeChatBrowser()) return;

  // 新版 API（微信 1.4.0+）
  window.wx.updateAppMessageShareData?.({
    title: data.title,
    desc: data.desc,
    link: data.link,
    imgUrl: data.imgUrl,
    success: () => console.log("[WxJsSdk] updateAppMessageShareData 设置成功"),
    fail: (err: any) => console.warn("[WxJsSdk] updateAppMessageShareData 失败:", err),
  });

  window.wx.updateTimelineShareData?.({
    title: data.title,
    link: data.link,
    imgUrl: data.imgUrl,
    success: () => console.log("[WxJsSdk] updateTimelineShareData 设置成功"),
    fail: (err: any) => console.warn("[WxJsSdk] updateTimelineShareData 失败:", err),
  });

  // 兼容旧版 API（部分安卓微信版本）
  window.wx.onMenuShareAppMessage?.({
    title: data.title,
    desc: data.desc,
    link: data.link,
    imgUrl: data.imgUrl,
  });

  window.wx.onMenuShareTimeline?.({
    title: data.title,
    link: data.link,
    imgUrl: data.imgUrl,
  });
}
