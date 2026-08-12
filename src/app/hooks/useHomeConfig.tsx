import { useState, useEffect } from "react";
import { storageGetJSON, storageSetJSON } from "../utils/safeStorage";
import { CONFIG_STORAGE_KEY } from "../constants";
import { applyResetConfigWithPreservedLocalSecrets } from "../services/ConfigSyncService";

// 首页配置数据结构
export interface BannerConfig {
  id: number;
  url: string;
  alt: string;
  title?: string;
  content?: string;  // 详情页内容
  videoUrl?: string;   // 详情页可播放视频；轮播仍用 url 作图
}

export interface NavigationItem {
  id: number;
  icon: string;
  title: string;
  subtitle: string;
}

export interface LiveStreamConfig {
  id: number;
  title: string;
  viewers: string;
  thumbnail: string;
  videoUrl?: string;
  // Per-video share settings
  shareEnabled?: boolean;
  shareUrl?: string;
  shareTitle?: string;
  shareText?: string;
  shareImgUrl?: string;
  wxJsSdkEnabled?: boolean;
  wxAppId?: string;
  wxSignatureApi?: string;
  // Per-video navigation settings
  navEnabled?: boolean;
  navLatitude?: string;
  navLongitude?: string;
  navAddress?: string;
  navCoordSystem?: CoordSystemType;
  navDisplayDays?: number;       // 导航按钮显示天数，默认15天，过期后自动隐藏
  navCreatedAt?: number;         // 导航启用时间戳（毫秒），首次启用时自动写入
  navBaiduMap?: boolean;
  navAmapMap?: boolean;
  navGoogleMap?: boolean;
  navAppleMaps?: boolean;
  navWaze?: boolean;
}

export interface ArticleConfig {
  id: number;
  title: string;
  author: string;
  views: string;
  category: string;
  date: string;
  content?: string;
  thumbnail?: string;
  videoUrl?: string;
}

export interface VideoFeedConfig {
  title: string;
  description: string;
  videoSources: string[];
}

// 第二页（MarketPage）配置接口
export interface MarketCategoryConfig {
  id: string;
  name: string;
  subCategories: string[];
}

export interface MarketProductConfig {
  id: number;
  name: string;
  image: string;
  price: string;
  category: string;       // 一级类别ID
  subCategory: string;    // 二级类别名称
  description?: string;
  stock?: number;
  details?: string;       // 详细说明
  specifications?: string; // 产品规格
  videoUrl?: string;
}

export interface MarketAdvertisementConfig {
  id: number;
  image: string;
  title: string;
  content?: string;   // 广告详情内容
}

// 备案信息配置接口
export interface FilingConfig {
  icpNumber: string;      // ICP备案号
  icpUrl: string;         // ICP备案链接
  policeNumber: string;   // 公安备案号
  policeUrl: string;      // 公安备案链接
}

// 关于我们配置接口
export interface AboutUsConfig {
  title: string;          // 标题
  content: string;        // 内容（支持换行）
}

// 隐私政策配置接口
export interface PrivacyPolicyConfig {
  title: string;          // 标题
  content: string;        // 内容（支持换行）
}

// 用户协议配置接口
export interface TermsOfServiceConfig {
  title: string;          // 标题
  content: string;        // 内容（支持换行）
}

// 技术支持 / 公司展示（设置页展示，可与法务同域管理）
export interface TechnicalSupportConfig {
  title: string;
  content: string;
}

// 应用品牌配置接口
export interface AppBrandingConfig {
  logoUrl: string;        // Logo图片URL
  appName: string;        // 应用名称
  slogan: string;         // Slogan
}

/** 启动页（/ 路由）：全屏图、最短展示、资源最长等待、跳过 */
export interface SplashScreenConfig {
  imageUrl: string;
  minDisplayMs: number;
  maxResourceWaitMs: number;
  showSkipButton: boolean;
}

// 首页功能图标配置接口
export interface HomeIconsConfig {
  aiAssistantIconUrl: string;   // AI助手图标URL（留空则使用默认lucide图标）
  aiAssistantLabel: string;     // AI助手按钮文字（留空则使用多语言默认值）
  statementIconUrl: string;     // 对账单图标URL（留空则使用默认lucide图标）
  statementLabel: string;       // 对账单按钮文字（留空则使用多语言默认值）
  liveCoverUrl: string;         // 直播区封面图URL（留空则使用第一条直播的缩略图）
  liveTitle: string;            // 直播区标题文字（留空则使用第一条直播标题）
  liveBadge: string;            // 直播区角标文字（留空则使用多语言默认值如"直播&导航"）
}

// 聊天联系人配置接口（账号级绑定：农户扫门店二维码后由 Edge 解析后写入）
// 展示用的 name/avatar/subtitle 由 merchant-bind-resolve 从 user_profiles 动态返回，
// 前端仅缓存本次扫码拉到的值，供无网络时展示；真源仍在云端。
export interface ChatContactConfig {
  merchantUserId: string;   // 门店 Supabase auth user id（= 二维码 /m/<uuid> 中的 uuid）
  channelId: string;        // merchant-bind-resolve 返回的 (merchant_user_id, farmer_user_id) 专属 channel
  name: string;             // 显示名（来自 user_profiles，缓存用）
  avatar: string;           // 显示头像（来自 user_profiles，缓存用）
  subtitle: string;         // 副标题（来自 user_profiles.bio，缓存用）
  verifiedDomains: string[]; // 域名白名单，扫码绑定时校验来源域名
  boundAt?: number;         // 绑定时间戳（扫码绑定成功后写入）
  boundFrom?: string;       // 绑定来源域名（扫码绑定成功后写入）
}

// 个人资料配置接口
export interface UserProfileConfig {
  name: string;           // 用户名称
  avatar: string;         // 用户头像URL
  /** 用户填写的手机号，同步至 user_profiles.phone（Edge POST /profile） */
  phone?: string;
  /** 提货点/地址，同步至 user_profiles.pickup_address，最多 200 字符 */
  pickupAddress?: string;
}

// 桌面图标配置接口
export interface DesktopIconConfig {
  appName: string;               // PWA应用名称
  icon192Url: string;            // 192x192 图标URL
  icon512Url: string;            // 512x512 图标URL
}

export interface PushConfig {
  vapidPublicKey: string;    // VAPID 公钥
  pushApiBase: string;       // 推送后端API基础路径 (例如 https://api.example.com)
  enabled: boolean;          // 是否启用推送功能
}

// 推送服务商类型
export type PushProvider = 'webpush' | 'fcm' | 'onesignal' | 'jpush' | 'getui';

// 多平台推送配置接口
export interface PushProvidersConfig {
  activeProvider: PushProvider;   // 当前激活的推送服务商

  // Web Push (VAPID) — 原生浏览器推送
  webpush: {
    enabled: boolean;
    vapidPublicKey: string;       // VAPID 公钥
    pushApiBase: string;          // 推送后端API基础路径
  };

  // Firebase Cloud Messaging
  fcm: {
    enabled: boolean;
    apiKey: string;               // Firebase Web API Key（公开）
    projectId: string;            // Firebase Project ID
    appId: string;                // Firebase App ID
    messagingSenderId: string;    // FCM Sender ID
    vapidKey: string;             // FCM Web Push VAPID Key
  };

  // OneSignal
  onesignal: {
    enabled: boolean;
    appId: string;                // OneSignal App ID（公开）
    safariWebId: string;          // Safari Web Push ID（可选）
  };

  // 极送 JPush
  jpush: {
    enabled: boolean;
    appKey: string;               // JPush App Key（公开）
    masterSecret: string;         // 仅展示标记，实际存后端
    channel: string;              // 推送渠道标识
    pushApiBase: string;          // JPush REST API 代理地址
  };

  // 个推 GeTui / UniPush
  getui: {
    enabled: boolean;
    appId: string;                // GeTui App ID（公开）
    appKey: string;               // GeTui App Key（公开）
    masterSecret: string;         // 仅展示标记，实际存后端
    pushApiBase: string;          // GeTui REST API 代理地址
  };
}

// AI模型配置接口
export interface AIModelConfig {
  modelUrl: string;          // ONNX 模型文件URL
  labelsUrl: string;         // 类别标签JSON文件URL
  enableLocalModel: boolean; // 是否启用本地ONNX推理模型（关闭则仅使用云端AI）
}

// 云端AI深度分析配置接口（后端代理模式）
export interface CloudAIConfig {
  enabled: boolean;                // 是否启用深度分析
  providerName: string;            // 显示名称（如：通义千问、Gemini、GPT-4o）
  edgeFunctionName: string;        // Supabase Edge Function 名称（默认 ai-vision-proxy）
  modelId: string;                 // 模型标识（传给Edge Function，如 qwen-vl-plus、gemini-2.0-flash）
  systemPrompt: string;            // 系统提示词（可自定义分析侧重点）
  maxTokens: number;               // 最大输出token数
  /** 前端日调用上限覆盖（未设置则用 cloudAIGuard 内置默认） */
  clientDailyLimit?: number;
  /** 前端两次调用最小间隔（秒）覆盖；Edge ai-vision-proxy 同步用于服务端 RPC 限流 */
  clientCooldownSeconds?: number;
  /**
   * 每用户每滚动分钟内容许的最大 AI 请求次数（Edge 滑动窗口）；未设则用 Edge 环境变量
   * `AI_RL_WINDOW_PER_MIN`（默认 6）。
   */
  clientWindowPerMin?: number;
  /**
   * 全站同时进行中的 AI 分析上限（Edge 并发槽位）；未设则用 Edge 默认（100，硬顶 100）。
   */
  clientMaxConcurrent?: number;
  /**
   * 追问/多轮对话在客户端的最小发送间隔（秒），宜 ≤ clientCooldownSeconds。
   * 未设置时与 clientCooldownSeconds 相同。
   */
  clientChatMinIntervalSeconds?: number;
  /** 上传前压缩最长边（像素）覆盖 */
  clientMaxImageSize?: number;
  /** JPEG 压缩质量 0–1 覆盖 */
  clientImageQuality?: number;
  /** 仅云端识图：Supabase 项目 URL（优先；留空则回退 backendProxyConfig，不依赖 IM 开关） */
  supabaseUrl?: string;
  /** 仅云端识图：Anon Key（优先；留空则回退 backendProxyConfig） */
  supabaseAnonKey?: string;
  /** 超级管理员：允许未登录用户使用 AI 助手（含云端与本地 ONNX） */
  allowUnauthenticatedUse?: boolean;
}

// 后端代理配置接口（Supabase 专用；聊天固定走 Supabase Realtime）
export type ChatProvider = 'supabase';
export type IMMode = 'im-provider-direct';

/** CMS 媒体上传后端（不含聊天）；非 supabase 时在 Edge Secrets 配置 R2/OSS/COS。 */
export type CmsStorageProvider =
  | 'supabase'
  | 'cloudflare_r2'
  | 'aliyun_oss'
  | 'tencent_cos';

export interface BackendProxyConfig {
  supabaseUrl: string;            // Supabase 项目 URL
  supabaseAnonKey: string;        // Supabase Anon Key（公开密钥，可安全放前端）
  /** Edge Function 名称，默认 server */
  edgeFunctionName?: string;
  /** 可选：脚本写入 app_config 时与 Edge Secret 对应（勿提交到公开仓库） */
  configWriteSecret?: string;
  enabled: boolean;               // 是否启用后端代理模式
  chatProvider: ChatProvider;     // 固定为 'supabase'
  imMode: IMMode;                 // 固定为 'im-provider-direct'（Supabase Realtime 订阅）
  /** CMS 上传存储位置，默认 supabase */
  cmsStorageProvider?: CmsStorageProvider;
  /** CMS 媒体 CDN 根地址；留空则展示回退 Supabase 公开 URL */
  mediaCdnBaseUrl?: string;
}

// 直播页分享配置接口
export interface LiveShareConfig {
  enabled: boolean;               // 是否启用分享按钮
  shareUrl: string;               // 分享的PWA链接（留空自动取当前域名）
  shareTitle: string;             // 分享标题
  shareText: string;              // 分享描述文字
  shareImgUrl: string;            // 分享缩略图URL（微信分享卡片用）
  // 微信 JS-SDK 自定义分享
  wxJsSdkEnabled: boolean;        // 是否启用微信JS-SDK自定义分享卡片
  wxAppId: string;                // 微信公众号 AppID
  wxSignatureApi: string;         // 后端签名接口URL（POST {url} → {appId,timestamp,nonceStr,signature}）
}

// 坐标系类型
export type CoordSystemType = 'wgs84' | 'gcj02' | 'bd09';

// 直播页导航配置接口（调用第三方地图App）
export interface LiveNavigationConfig {
  enabled: boolean;               // 是否启用导航按钮
  latitude: string;               // 目的地纬度
  longitude: string;              // 目的地经度
  address: string;                // 显示地址名称
  coordSystem: CoordSystemType;   // 输入坐标系：wgs84 / gcj02 / bd09
  // 地图App开关 — 中国区
  baiduMap: boolean;              // 百度地图
  amapMap: boolean;               // 高德地图
  // 国际区
  googleMap: boolean;             // Google Maps
  appleMaps: boolean;             // Apple Maps
  waze: boolean;                  // Waze
}

// 登录页面配置接口
export interface OAuthProviderCredentials {
  wechat: { appId: string };
  google: { clientId: string };
  facebook: { appId: string };
  apple: { serviceId: string; teamId: string; keyId: string };
  alipay: { appId: string };
  twitter: { apiKey: string };
}

export interface LoginConfig {
  socialProviders: {
    wechat: boolean;
    google: boolean;
    facebook: boolean;
    apple: boolean;
    alipay: boolean;
    twitter: boolean;
  };
  oauthCredentials: OAuthProviderCredentials;
  enablePhoneLogin: boolean;      // 是否启用机号登录
  enableEmailLogin: boolean;      // 是否启用邮箱登录
  defaultLoginMethod: 'phone' | 'email'; // 默认选中的登录方式
}

export interface MarketPageConfig {
  categories: MarketCategoryConfig[];
  products: MarketProductConfig[];
  advertisements: MarketAdvertisementConfig[];
}

export interface HomePageConfig {
  banners: BannerConfig[];
  navigation: NavigationItem[];
  liveStreams: LiveStreamConfig[];
  articles: ArticleConfig[];
  videoFeed: VideoFeedConfig;
  marketPage: MarketPageConfig; // 添加第二页配置
  currencySymbol: string; // 货币符号，如 ¥、$、€
  filing: FilingConfig; // 备案信息
  aboutUs: AboutUsConfig; // 关于我们
  privacyPolicy: PrivacyPolicyConfig; // 隐私政策
  termsOfService: TermsOfServiceConfig; // 用户协议
  technicalSupport: TechnicalSupportConfig; // 技术支持（公司广告/介绍）
  appBranding: AppBrandingConfig; // 应用品牌
  splashScreen: SplashScreenConfig; // 启动页全屏图与时长、跳过
  homeIcons: HomeIconsConfig; // 首页功能图标配置
  chatContact: ChatContactConfig; // 聊天联系人
  /** 聊天 Tab UI：农户单聊 / 门店多会话 */
  communityUiMode: 'farmer' | 'store';
  userProfile: UserProfileConfig; // 个人资料
  desktopIcon: DesktopIconConfig; // 桌面图标配置
  pushConfig: PushConfig; // 推送通知配置
  pushProvidersConfig: PushProvidersConfig; // 多平台推送服务商配置
  aiModelConfig: AIModelConfig; // AI模型配置
  cloudAIConfig: CloudAIConfig; // 云端AI度分析配置
  backendProxyConfig: BackendProxyConfig; // 后端代理配置
  loginConfig: LoginConfig; // 登录页面配置
  liveShareConfig: LiveShareConfig; // 直播页分享配置
  liveNavigationConfig: LiveNavigationConfig; // 直播页导航配置
  /**
   * 资料已完善用户两次保存个人资料的最短间隔（秒）。0 表示不限制。
   * 默认 300（5 分钟），可在 app.json 调整。
   */
  profileEditCooldownSeconds: number;
}

// 默认配置从 /taprootagrosetting/ JSON 文件聚合导入
// 骨架代码更新时只需复制 /taprootagrosetting/ 文件夹即可保留所有配置
import { defaultConfig } from '/taprootagrosetting';
export { defaultConfig };

// 这个 hook 现在只是为了向后兼容，建议使用 useConfig from ConfigContext
export function useHomeConfig() {
  // 导入 ConfigContext 的 hook
  // 为了避免循环依赖，我们保持这个 hook 的独立实现
  // 但添加事件监听来同步更新
  const [config, setConfig] = useState<HomePageConfig>(() => {
    // 从 localStorage 加载配置
    const parsedConfig = storageGetJSON<Record<string, any>>(CONFIG_STORAGE_KEY);
    if (parsedConfig) {
      try {
        // 合并默认配置以确保所有字段都存在
        return {
          ...defaultConfig,
          ...parsedConfig,
          marketPage: {
            ...defaultConfig.marketPage,
            ...(parsedConfig.marketPage || {}),
            categories: parsedConfig.marketPage?.categories || defaultConfig.marketPage.categories,
            products: parsedConfig.marketPage?.products || defaultConfig.marketPage.products,
            advertisements: parsedConfig.marketPage?.advertisements || 
              (parsedConfig.marketPage?.advertisement ? [parsedConfig.marketPage.advertisement] : defaultConfig.marketPage.advertisements),
          },
          filing: parsedConfig.filing || defaultConfig.filing,
          aboutUs: parsedConfig.aboutUs || defaultConfig.aboutUs,
          privacyPolicy: parsedConfig.privacyPolicy || defaultConfig.privacyPolicy,
          termsOfService: parsedConfig.termsOfService || defaultConfig.termsOfService,
          technicalSupport: parsedConfig.technicalSupport || defaultConfig.technicalSupport,
          appBranding: parsedConfig.appBranding || defaultConfig.appBranding,
          splashScreen: {
            ...defaultConfig.splashScreen,
            ...(parsedConfig.splashScreen || {}),
          },
          homeIcons: parsedConfig.homeIcons || defaultConfig.homeIcons,
          chatContact: {
            ...defaultConfig.chatContact,
            ...(parsedConfig.chatContact || {}),
          },
          communityUiMode:
            parsedConfig.communityUiMode === 'store' || parsedConfig.communityUiMode === 'farmer'
              ? parsedConfig.communityUiMode
              : defaultConfig.communityUiMode,
          userProfile: parsedConfig.userProfile || defaultConfig.userProfile,
          desktopIcon: {
            ...defaultConfig.desktopIcon,
            ...(parsedConfig.desktopIcon || {}),
          },
          pushConfig: parsedConfig.pushConfig || defaultConfig.pushConfig,
          pushProvidersConfig: parsedConfig.pushProvidersConfig || defaultConfig.pushProvidersConfig,
          aiModelConfig: {
            ...defaultConfig.aiModelConfig,
            ...(parsedConfig.aiModelConfig || {}),
          },
          cloudAIConfig: {
            ...defaultConfig.cloudAIConfig,
            ...(parsedConfig.cloudAIConfig || {}),
          },
          backendProxyConfig: { ...defaultConfig.backendProxyConfig, ...(parsedConfig.backendProxyConfig || {}) },
          loginConfig: parsedConfig.loginConfig || defaultConfig.loginConfig,
          liveShareConfig: parsedConfig.liveShareConfig || defaultConfig.liveShareConfig,
          liveNavigationConfig: parsedConfig.liveNavigationConfig || defaultConfig.liveNavigationConfig
        };
      } catch (e) {
        console.error("Failed to parse config:", e);
        return defaultConfig;
      }
    }
    return defaultConfig;
  });

  // 监听配置更新事件
  useEffect(() => {
    const handleConfigUpdate = (e: Event) => {
      const customEvent = e as CustomEvent<HomePageConfig>;
      if (customEvent.detail) {
        console.log('🔄 配置已更新 - useHomeConfig', new Date().toLocaleTimeString());
        setConfig(customEvent.detail);
      }
    };

    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === CONFIG_STORAGE_KEY && e.newValue) {
        try {
          const newConfig = JSON.parse(e.newValue);
          console.log('🔄 Storage 更新 - useHomeConfig', new Date().toLocaleTimeString());
          setConfig(newConfig);
        } catch (error) {
          console.error("Failed to parse storage change:", error);
        }
      }
    };

    window.addEventListener('configUpdate', handleConfigUpdate);
    window.addEventListener('storage', handleStorageChange);

    return () => {
      window.removeEventListener('configUpdate', handleConfigUpdate);
      window.removeEventListener('storage', handleStorageChange);
    };
  }, []);

  // 保存配置到 localStorage
  const saveConfig = (newConfig: HomePageConfig) => {
    console.log('💾 保存配置 - useHomeConfig', new Date().toLocaleTimeString());
    setConfig(newConfig);
    storageSetJSON(CONFIG_STORAGE_KEY, newConfig);
    // 触发自定义事件，通知其他组件
    window.dispatchEvent(new CustomEvent('configUpdate', { detail: newConfig }));
  };

  // 重置为默认配置（与 ConfigProvider.resetConfig 语义一致：保留本机 configWriteSecret；不登出）
  const resetConfig = () => {
    const next = applyResetConfigWithPreservedLocalSecrets(defaultConfig, config);
    setConfig(next);
    storageSetJSON(CONFIG_STORAGE_KEY, next);
    window.dispatchEvent(new CustomEvent("configUpdate", { detail: next }));
  };

  // 导出配置为 JSON 文件
  const exportConfig = () => {
    const dataStr = JSON.stringify(config, null, 2);
    const dataBlob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(dataBlob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `home-config-${new Date().toISOString().split('T')[0]}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  // 导入配置从 JSON 文件
  const importConfig = (file: File) => {
    return new Promise<void>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const imported = JSON.parse(e.target?.result as string);
          saveConfig(imported);
          resolve();
        } catch (error) {
          reject(error);
        }
      };
      reader.onerror = reject;
      reader.readAsText(file);
    });
  };

  return {
    config,
    saveConfig,
    resetConfig,
    exportConfig,
    importConfig,
    defaultConfig
  };
}