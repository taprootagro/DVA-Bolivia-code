/**
 * 将内容管理器完整 config（与 agri_home_config / .tmp-seed.json 同结构）
 * 拆分写入 taprootagrosetting/*.json。
 *
 * 用法：
 *   node scripts/apply-config-to-settings.mjs [config.json]
 *   默认读取项目根 cms-export.json，不存在则读 .tmp-seed.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const settingDir = path.join(root, 'taprootagrosetting');

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJsonFile(fileName, data) {
  fs.writeFileSync(
    path.join(settingDir, fileName),
    JSON.stringify(data, null, 2) + '\n',
    'utf8',
  );
}

function resolveInputPath(argPath) {
  if (argPath) return path.resolve(argPath);
  const cmsExport = path.join(root, 'cms-export.json');
  if (fs.existsSync(cmsExport)) return cmsExport;
  return path.join(root, '.tmp-seed.json');
}

function splitConfigToSettings(cfg) {
  writeJsonFile('home.json', {
    banners: cfg.banners ?? [],
    navigation: cfg.navigation ?? [],
    liveStreams: cfg.liveStreams ?? [],
    articles: cfg.articles ?? [],
    videoFeed: cfg.videoFeed ?? { title: '', description: '', videoSources: [] },
    homeIcons: cfg.homeIcons ?? {
      aiAssistantIconUrl: '',
      aiAssistantLabel: '',
      statementIconUrl: '',
      statementLabel: '',
      liveCoverUrl: '',
      liveTitle: '',
      liveBadge: '',
    },
  });

  writeJsonFile('market.json', {
    currencySymbol: cfg.currencySymbol ?? '¥',
    marketPage: cfg.marketPage ?? { categories: [], products: [], advertisements: [] },
  });

  writeJsonFile('app.json', {
    profileEditCooldownSeconds:
      typeof cfg.profileEditCooldownSeconds === 'number'
        ? Math.max(0, Math.floor(cfg.profileEditCooldownSeconds))
        : 300,
    appBranding: cfg.appBranding ?? { logoUrl: '', appName: '', slogan: '' },
    splashScreen: cfg.splashScreen ?? {
      imageUrl: '',
      minDisplayMs: 2000,
      maxResourceWaitMs: 4000,
      showSkipButton: true,
    },
    desktopIcon: cfg.desktopIcon ?? { appName: '', icon192Url: '', icon512Url: '' },
    filing: cfg.filing ?? { icpNumber: '', icpUrl: '', policeNumber: '', policeUrl: '' },
  });

  writeJsonFile('chat.json', {
    communityUiMode: cfg.communityUiMode ?? 'farmer',
    chatContact: cfg.chatContact ?? {
      name: '',
      avatar: '',
      subtitle: '',
      imUserId: '',
      imProvider: 'tencent-im',
      channelId: '',
      phone: '',
      storeId: '',
      verifiedDomains: [],
    },
    userProfile: cfg.userProfile ?? { name: '', avatar: '' },
  });

  writeJsonFile('legal.json', {
    aboutUs: cfg.aboutUs ?? { title: '', content: '' },
    privacyPolicy: cfg.privacyPolicy ?? { title: '', content: '' },
    termsOfService: cfg.termsOfService ?? { title: '', content: '' },
    technicalSupport: cfg.technicalSupport ?? { title: '', content: '' },
  });

  writeJsonFile('ai.json', {
    aiModelConfig: cfg.aiModelConfig ?? { modelUrl: '', labelsUrl: '', enableLocalModel: false },
    cloudAIConfig: cfg.cloudAIConfig ?? {
      enabled: false,
      providerName: '',
      edgeFunctionName: 'ai-vision-proxy',
      modelId: '',
      systemPrompt: '',
      maxTokens: 512,
      supabaseUrl: '',
      supabaseAnonKey: '',
    },
  });

  writeJsonFile('push.json', {
    pushConfig: cfg.pushConfig ?? { vapidPublicKey: '', pushApiBase: '', enabled: false },
    pushProvidersConfig: cfg.pushProvidersConfig ?? {
      activeProvider: 'webpush',
      webpush: { enabled: false, vapidPublicKey: '', pushApiBase: '' },
      fcm: { enabled: false, apiKey: '', projectId: '', appId: '', messagingSenderId: '', vapidKey: '' },
      onesignal: { enabled: false, appId: '', safariWebId: '' },
      jpush: { enabled: false, appKey: '', masterSecret: '', channel: '', pushApiBase: '' },
      getui: { enabled: false, appId: '', appKey: '', masterSecret: '', pushApiBase: '' },
    },
  });

  writeJsonFile('auth.json', {
    loginConfig: cfg.loginConfig ?? {
      socialProviders: {
        wechat: true,
        google: true,
        facebook: true,
        apple: true,
        alipay: true,
        twitter: true,
        line: true,
      },
      oauthCredentials: {
        wechat: { appId: '' },
        google: { clientId: '' },
        facebook: { appId: '' },
        apple: { serviceId: '', teamId: '', keyId: '' },
        alipay: { appId: '' },
        twitter: { apiKey: '' },
        line: { channelId: '' },
      },
      enablePhoneLogin: true,
      enableEmailLogin: true,
      defaultLoginMethod: 'phone',
    },
  });

  writeJsonFile('live.json', {
    liveShareConfig: cfg.liveShareConfig ?? {
      enabled: false,
      shareUrl: '',
      shareTitle: '',
      shareText: '',
      shareImgUrl: '',
      wxJsSdkEnabled: false,
      wxAppId: '',
      wxSignatureApi: '',
    },
    liveNavigationConfig: cfg.liveNavigationConfig ?? {
      enabled: false,
      latitude: '',
      longitude: '',
      address: '',
      coordSystem: 'wgs84',
      baiduMap: false,
      amapMap: false,
      googleMap: false,
      appleMaps: false,
      waze: false,
    },
  });

  writeJsonFile('backend.json', {
    backendProxyConfig: cfg.backendProxyConfig ?? {
      supabaseUrl: '',
      supabaseAnonKey: '',
      edgeFunctionName: 'server',
      enabled: false,
      chatProvider: 'supabase',
      imMode: 'im-provider-direct',
      cmsStorageProvider: 'supabase',
      mediaCdnBaseUrl: '',
    },
  });
}

const inputPath = resolveInputPath(process.argv[2]);
if (!fs.existsSync(inputPath)) {
  console.error(`[apply-config-to-settings] input not found: ${inputPath}`);
  console.error('Save in Content Manager (npm run dev) or place cms-export.json at project root.');
  process.exit(1);
}

const cfg = readJsonFile(inputPath);
splitConfigToSettings(cfg);
console.log(`[apply-config-to-settings] wrote taprootagrosetting/*.json from ${path.basename(inputPath)}`);
