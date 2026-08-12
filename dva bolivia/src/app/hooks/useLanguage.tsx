import { createContext, useContext, useState, useEffect, useRef, ReactNode } from 'react';
import { storageGet, storageSet } from '../utils/safeStorage';
import enTranslations from '../i18n/lang/en';
import zhTranslations from '../i18n/lang/zh';
import zhTWTranslations from '../i18n/lang/zh-TW';

// 支持的语言列表
export type Language = 'en' | 'zh' | 'zh-TW' | 'es' | 'fr' | 'ar' | 'pt' | 'hi' | 'ru' | 'bn' | 'ur' | 'id' | 'vi' | 'ms' | 'ja' | 'th' | 'my' | 'tl' | 'tr' | 'fa';

// 语言配置
export const languages: Record<Language, { name: string; nativeName: string; rtl?: boolean }> = {
  en: { name: 'English', nativeName: 'English' },
  zh: { name: 'Chinese', nativeName: '简体中文' },
  'zh-TW': { name: 'Traditional Chinese', nativeName: '繁體中文' },
  es: { name: 'Spanish', nativeName: 'Español' },
  fr: { name: 'French', nativeName: 'Français' },
  ar: { name: 'Arabic', nativeName: 'العربية', rtl: true },
  pt: { name: 'Portuguese', nativeName: 'Português' },
  hi: { name: 'Hindi', nativeName: 'हिन्दी' },
  ru: { name: 'Russian', nativeName: 'Русский' },
  bn: { name: 'Bengali', nativeName: 'বাংলা' },
  ur: { name: 'Urdu', nativeName: 'اردو', rtl: true },
  id: { name: 'Indonesian', nativeName: 'Indonesia' },
  vi: { name: 'Vietnamese', nativeName: 'Tiếng Việt' },
  ms: { name: 'Malay', nativeName: 'Bahasa Melayu' },
  ja: { name: 'Japanese', nativeName: '日本語' },
  th: { name: 'Thai', nativeName: 'ภาษาไทย' },
  my: { name: 'Burmese', nativeName: 'မြန်မာဘာသာ' },
  tl: { name: 'Filipino', nativeName: 'Filipino' },
  tr: { name: 'Turkish', nativeName: 'Türkçe' },
  fa: { name: 'Persian', nativeName: 'فارسی', rtl: true },
};

// 翻译字典类型
export interface Translations {
  common: {
    appName: string;
    home: string;
    market: string;
    community: string;
    profile: string;
    settings: string;
    login: string;
    logout: string;
    search: string;
    cancel: string;
    confirm: string;
    save: string;
    back: string;
    loading: string;
    error: string;
    success: string;
    close: string;
    skip: string;
    newVersionAvailable: string;
    tapToUpdate: string;
    updating: string;
    update: string;
    updateOnRestart: string;
    featureComingSoon?: string;
    noContent?: string;
    noResults?: string;
    qrData?: string;
  };
  
  home: {
    greeting: string;
    quickActions: string;
    weatherToday: string;
    soilMoisture: string;
    cropHealth: string;
    news: string;
    tips: string;
    searchPlaceholder: string;
    aiAssistant: string;
    statement: string;
    liveNavigation: string;
    reference: string;
    agriVideos: string;
    filingNo: string;
  };
  
  market: {
    title: string;
    categories: string;
    seeds: string;
    fertilizer: string;
    tools: string;
    pesticides: string;
    featured: string;
    newArrival: string;
    price: string;
    addToCart: string;
    viewDetails: string;
    searchProducts: string;
    herbicide: string;
    insecticide: string;
    fungicide: string;
    biostimulant: string;
    corn: string;
    rice: string;
    coffee: string;
    preAndPostEmergence: string;
    preEmergence: string;
    midPostEmergence: string;
    productDetail?: string;
    stock?: string;
    details?: string;
    specifications?: string;
  };
  
  community: {
    title: string;
    myPosts?: string;
    trending?: string;
    latest?: string;
    createPost?: string;
    viewMore?: string;
    comments?: string;
    likes?: string;
    share?: string;
    unreadMessages: string;
    holdToTalk: string;
    typeMessage: string;
    audioCall: string;
    videoCall: string;
    loginRequired?: string;
    loginToChat?: string;
    goToLogin?: string;
    switchingRoleMode?: string;
    scanning?: string;
    verifyingDomain?: string;
    domainVerified?: string;
    domainFailed?: string;
    channelIdLabel?: string;
    imProviderLabel?: string;
    bindWarning?: string;
    confirmBind?: string;
    domainRejectedHint?: string;
    sourceLabel?: string;
    gotIt?: string;
    sendRecordedVideo?: string;
    storeRecentsTitle?: string;
    storeRecentsEmpty?: string;
    storeFarmerFallback?: string;
    openContacts?: string;
    contactsEntrySubtitle?: string;
    contacts?: string;
    contactsEmpty?: string;
    addContact?: string;
    contactName?: string;
    contactNamePh?: string;
    deleteThread?: string;
    blockContact?: string;
    confirmDeleteThread?: string;
    confirmBlockContact?: string;
    storeThreadSubtitle?: string;
    unblockContact?: string;
    confirmUnblockContact?: string;
    restoreContact?: string;
    deleteContact?: string;
    confirmDeleteContact?: string;
    contactBlockedLabel?: string;
    peerLimitReached?: string;
    threadInputBlockedHint?: string;
    storeScanRejectMerchantBindQr?: string;
    scanNeedFarmerLogin?: string;
    qrNotSupported?: string;
    noQrDetected?: string;
    scanFailed?: string;
    chatCompressingImage?: string;
    chatImageTooLarge?: string;
    chatImageUnsupported?: string;
    chatImageProcessFailed?: string;
  };
  
  camera: {
    title: string;
    scanQRCode: string;
    takePicture: string;
    takePhoto?: string;
    cameraError: string;
    cameraErrorMessage: string;
    close: string;
    permissionDenied: string;
    permissionDeniedMessage: string;
    noCamera: string;
    startFailed: string;
    cameraUnavailable: string;
    retry: string;
    chooseFromAlbum: string;
    startingCamera: string;
    chooseSource?: string;
  };
  
  profile: {
    title: string;
    myInfo: string;
    statistics: string;
    myFarm: string;
    favorites: string;
    orders: string;
    wallet: string;
    settings: string;
    help: string;
    pickupInfo: string;
    allOrders: string;
    pendingReceipt: string;
    pendingPayment: string;
    invoiceRecords: string;
    abnormalFeedback: string;
    aboutUs: string;
    logout: string;
    loginPrompt: string;
    editProfile?: string;
    editAvatar?: string;
    nickname?: string;
    nicknamePlaceholder?: string;
    userId?: string;
    profileUpdated?: string;
    /** POST /profile 成功后的提示 */
    profileSavedSynced?: string;
    /** 仅写入 localStorage、未走云端时 */
    profileSavedLocalOnly?: string;
    /** 编辑资料：展示 Google/微信等绑定账号 */
    linkedLoginTitle?: string;
    linkedLoginHint?: string;
    /** 已保存到本机，但同步到 Supabase（Edge POST /profile）失败 */
    profileCloudSyncFailed?: string;
    logoutConfirm?: string;
    logoutConfirmDesc?: string;
    traceabilityResult?: string;
    productCode?: string;
    scanTime?: string;
    verifyAuthentic?: string;
    copyCode?: string;
    codeCopied?: string;
    sendImage?: string;
    previewImage?: string;
    myQRCode?: string;
    addressPlaceholder?: string;
    storeBindQrTitle?: string;
    storeBindQrHint?: string;
    storeBindQrGenerate?: string;
    storeBindQrRegenerate?: string;
    storeBindQrCopyLink?: string;
    storeBindQrNeedHttps?: string;
    storeBindQrCopyFailed?: string;
    storeBindCardTitle?: string;
    storeBindCardSubtitle?: string;
    farmerQrHint?: string;
    phone?: string;
    phonePlaceholder?: string;
    phoneHint?: string;
    addPhoneHint?: string;
    completeProfileFirst?: string;
    pickupAddressLabel?: string;
    pickupAddressLimit?: string;
    avatarTooLarge?: string;
    /** 占位符 {minutes} {seconds} */
    profileEditCooldownWait?: string;
    /** 编辑页：Google 等关联登录标签（展示在邮箱前） */
    linkedLoginGoogle?: string;
    /** 编辑页：用户 ID 下方说明（服务器分配） */
    userIdServerHint?: string;
    /** 编辑页：用户 ID 下方说明（本地演示） */
    userIdLocalHint?: string;
    /** 提货地址输入框占位 */
    pickupAddressPlaceholder?: string;
    /** 更换头像按钮无障碍名称 */
    changeAvatarA11y?: string;
    /** 保存按钮进行中 */
    profileSaving?: string;
    /** 昵称为空且本地也无缓存时的展示默认（勿用人名） */
    defaultDisplayNameFallback?: string;
    /** 头像预览图 alt（可选） */
    profileAvatarAlt?: string;
    /** 门店模式下仅账号持有者可见提示 */
    storeQrAccountOnlyHint?: string;
    /** 未配置域名时的提示 */
    storeBindQrNeedDomain?: string;
  };
  
  settings: {
    title: string;
    advancedFeatures: string;
    pushNotifications: string;
    pushNotificationsDesc: string;
    backgroundSync: string;
    backgroundSyncDesc: string;
    generalSettings: string;
    language: string;
    languageDesc: string;
    theme?: string;
    themeLight?: string;
    themeDark?: string;
    privacy: string;
    privacyPolicy: string;
    privacyPolicyDesc: string;
    privacyPolicyText: string;
    termsOfService: string;
    termsOfServiceDesc: string;
    termsOfServiceText: string;
    technicalSupport: string;
    technicalSupportDesc: string;
    technicalSupportText: string;
    version: string;
    configManager: string;
    configManagerDesc: string;
    permissions: string;
    permissionsDesc: string;
    permissionsIntroTitle: string;
    permissionsIntroSubtitle: string;
    permissionsIntroLineCamera: string;
    permissionsIntroLineMic: string;
    permissionsIntroLineLocation: string;
    permissionsIntroContinue: string;
    permissionsIntroLater: string;
    permissionsCamera: string;
    permissionsMicrophone: string;
    permissionsLocation: string;
    permissionsOsGranted: string;
    permissionsOsDenied: string;
    permissionsOsPrompt: string;
    permissionsOsUnsupported: string;
    permissionsAppEnabled: string;
    permissionsAppDisabledHint: string;
    permissionsReRequest: string;
    permissionsOpenSystem: string;
    permissionsWebSettingsHint: string;
    accountManagement: string;
    accountManagementDesc: string;
    accountManagementSummaryHint: string;
    accountManagementDisplayName: string;
    accountManagementPhone: string;
    accountManagementUserId: string;
    accountManagementAnonymous: string;
    accountManagementLocalOnlyHint: string;
    accountDeleteTitle: string;
    accountDeleteWarning: string;
    accountDeleteConfirmDesc: string;
    accountDeleteConfirmLabel: string;
    accountDeleteConfirmWord: string;
    accountDeleteAck: string;
    accountDeleteSuccess: string;
    accountDeleteFailed: string;
    accountDeleteSessionExpired: string;
    accountDeleteRateLimited: string;
    accountDeleteInProgress: string;
    accountDeleteCmsWarning: string;
    accountDeletedSenderLabel: string;
  };
  
  login: {
    title: string;
    subtitle: string;
    welcomeTitle: string;
    welcomeSubtitle: string;
    email: string;
    password: string;
    forgotPassword: string;
    loginButton: string;
    signUp: string;
    or: string;
    socialLogin: string;
    google: string;
    facebook: string;
    apple: string;
    quickLogin: string;
    accountLogin: string;
    phone: string;
    verificationCode: string;
    getCode: string;
    oneClickLogin: string;
    agreeTerms: string;
    userAgreement: string;
    and: string;
    privacyPolicy: string;
    agreeFirst: string;
    phonePlaceholder: string;
    emailPlaceholder: string;
    passwordPlaceholder?: string;
    passwordRequired?: string;
    emailUseCodeLogin?: string;
    emailUsePasswordLogin?: string;
    resetPasswordSent?: string;
    resetPasswordFailed?: string;
    codePlaceholder: string;
    wechat: string;
    alipay: string;
    twitter: string;
    line: string;
    codeSent: string;
    codeSendFailed: string;
    codeCountdown: string;
    invalidPhone: string;
    invalidEmail: string;
    codeRequired: string;
    loginFailed: string;
    redirecting: string;
    oauthNotConfigured: string;
    /** WeChat / Alipay / LINE — not mapped to Supabase built-in providers */
    oauthUnsupportedProvider?: string;
    /** One-line under Quick Login: Google/Apple/… vs WeChat need Custom OAuth */
    oauthBuiltinHint?: string;
    /** Long copy when user taps WeChat / Alipay with backend on（Edge 换票路径） */
    oauthWechatAlipayEdge?: string;
    /** getSupabaseBrowserClient() returned null */
    supabaseAuthMissing?: string;
    oauthError: string;
    /** PKCE verifier missing — explained for PWA / cross-browser flows */
    oauthPkceVerifierHint?: string;
    networkError: string;
    backendRequired: string;
    demoLoginNote: string;
  };

  statement: {
    title: string;
    balance: string;
    income: string;
    expense: string;
    noRecords: string;
    startRecording: string;
    edit: string;
    delete: string;
    editRecord: string;
    addRecord: string;
    type: string;
    amount: string;
    category: string;
    date: string;
    noteOptional: string;
    notePlaceholder: string;
    saveChanges: string;
    customCategory: string;
    confirmDelete: string;
    fillRequired: string;
    invalidAmount: string;
    salary: string;
    bonus: string;
    investment: string;
    partTime: string;
    cropSales: string;
    subsidy: string;
    otherIncome: string;
    seeds: string;
    fertilizer: string;
    pesticide: string;
    equipment: string;
    labor: string;
    rent: string;
    utilities: string;
    transport: string;
    food: string;
    otherExpense: string;
    exportData: string;
    importData: string;
    exportSuccess: string;
    importSuccess: string;
    importFailed: string;
    importConfirm: string;
    recordCount: string;
    lastBackup: string;
    dataManagement: string;
    monthFilter: string;
    allMonths: string;
    error?: string;
  };

  ai: {
    title: string;
    loadingModel: string;
    modelReady: string;
    classes: string;
    demoMode: string;
    simulatedResults: string;
    loadFailed: string;
    retry: string;
    noModel: string;
    noModelDesc: string;
    step1: string;
    step2: string;
    step3: string;
    labelExample: string;
    enterDemo: string;
    redetectModel: string;
    photoDetect: string;
    photoDetectDesc: string;
    takePhoto: string;
    selectAlbum: string;
    selectSample: string;
    targets: string;
    aiAnalyzing: string;
    startDetect: string;
    detected: string;
    redetect: string;
    demoNote: string;
    noTarget: string;
    tryClearer: string;
    retakePhoto: string;
    tomatoLeaf: string;
    cornField: string;
    riceField: string;
    tomatoEarlyBlight: string;
    leafSpot: string;
    cornRust: string;
    graySpot: string;
    riceBlast: string;
    sheathBlight: string;
    brownPlanthopper: string;
    deepAnalysis: string;
    deepAnalysisDesc: string;
    deepAnalyzing: string;
    deepAnalysisResult: string;
    deepAnalysisMock: string;
    deepAnalysisError: string;
    deepAnalysisRetry: string;
    deepAnalysisNotConfigured: string;
    poweredBy: string;
    copyReport: string;
    copied: string;
    collapse: string;
    expand: string;
    disclaimer: string;
    cloudOnlyMode: string;
    cloudOnlyDesc: string;
    cloudAnalyzeBtn: string;
    cloudAnalyzeBtnDesc: string;
    dailyLimitReached: string;
    dailyUsageInfo: string;
    cooldownWait: string;
    /** Image too small after compression for cloud vision */
    imageTooSmall: string;
    /** 追问连发过快（客户端或服务端限流） */
    chatMessageTooFast: string;
    /** 全站 AI 并发满员，客户端自动重试排队中 */
    serverBusyRetry: string;
    /** 排队自动重试耗尽仍满员 */
    serverBusyTimeout: string;
    cachedResult: string;
    compressingImage: string;
    chatPlaceholder: string;
    chatSend: string;
    aiReplying: string;
    holdToSpeak: string;
    releaseToSend: string;
    voiceMsg: string;
    micDenied: string;
    networkErrorHint: string;
    localAINoVoice: string;
    aiDisabledBothTitle: string;
    aiDisabledBothDesc: string;
    offlineNoAiTitle: string;
    offlineCloudOnlyNoLocal: string;
    cloudAiDisabled: string;
    localAiOffCannotLoad: string;
    sttNotSupported?: string;
    sttNoResult?: string;
    sttFailed?: string;
    /** 需登录后使用云端 AI 时的短提示（对话 / 深度分析，与语言一致） */
    aiLoginRequired: string;
    /** 登录与 Supabase 项目不一致等时的补充说明（可选，与 zh 等语言一致） */
    cloudAiNotLoggedInHint?: string;
  };

  video?: {
    liveAndVideo: string;
    liveNow: string;
    viewersWatching: string;
    pastReplays: string;
    noLiveContent: string;
    addLiveDataHint: string;
    loadFailed: string;
    checkVideoUrl: string;
    share: string;
    navigation: string;
    navigationWip: string;
    views: string;
    sampleVideo: string;
    agriShortVideo: string;
    close: string;
    chooseNavApp?: string;
    linkCopied?: string;
    shareHint?: string;
    baiduMaps?: string;
    amapMaps?: string;
  };

  desktopIcon?: {
    title: string;
    description: string;
    bgColor: string;
    iconText: string;
    textColor: string;
    borderEnabled: string;
    borderColor: string;
    cornerRadius: string;
    appNameLabel: string;
    customIconUrl: string;
    customIconUrlPlaceholder: string;
    customIconUrlHint: string;
    preview: string;
    homeScreenPreview: string;
    generate: string;
    download: string;
    downloadAll: string;
    size192: string;
    size512: string;
    generateSuccess: string;
    instructions: string;
    instructionStep1: string;
    instructionStep2: string;
    instructionStep3: string;
    useCustomImage: string;
    useTextIcon: string;
    tips: string;
    tipApple: string;
    tipAndroid: string;
    tipSize: string;
    resetDefaults: string;
    tabLabel: string;
    fontSizeLabel: string;
  };

  pushNotifications: {
    title: string;
    enabled: string;
    denied: string;
    disabled: string;
    enableButton: string;
    enabling: string;
    testButton: string;
    disableButton: string;
    disabling: string;
    notSupported: string;
    notSupportedDesc: string;
    permissionDenied: string;
    permissionFailed: string;
    subscribeFailed: string;
    unsubscribeFailed: string;
    tip: string;
    testTitle: string;
    testBody: string;
    needPermission: string;
    noBackendNote: string;
  };

  configManager?: {
    sidebar: Record<string, string>;
    navItems: Record<string, string>;
    topBar: Record<string, string>;
    buttons: Record<string, string>;
    headers: Record<string, string>;
    commonLabels: Record<string, string>;
    pushNotification?: Record<string, string>;
    messages?: Record<string, string>;
  };
}

// 检测浏览器语言
function detectBrowserLanguage(): Language {
  if (typeof navigator === 'undefined') return 'en';
  
  try {
    const browserLang = navigator.language || (navigator as any).userLanguage || '';

    // 先尝试完整匹配 (e.g. "zh-TW", "zh-HK", "zh-Hant")
    const fullTag = browserLang.replace('_', '-'); // 有些浏览器用下划线
    if (/^zh[-_](TW|HK|Hant)/i.test(fullTag)) return 'zh-TW';

    const langCode = fullTag.split('-')[0].toLowerCase();
    
    const languageMap: Record<string, Language> = {
      'en': 'en',
      'zh': 'zh',
      'es': 'es',
      'fr': 'fr',
      'ar': 'ar',
      'pt': 'pt',
      'hi': 'hi',
      'ru': 'ru',
      'bn': 'bn',
      'ur': 'ur',
      'id': 'id',
      'vi': 'vi',
      'ms': 'ms',
      'ja': 'ja',
      'th': 'th',
      'my': 'my',
      'tl': 'tl',
      'tr': 'tr',
      'fa': 'fa',
    };
    
    return languageMap[langCode] || 'en';
  } catch {
    return 'en';
  }
}

// 翻译数据（en/zh/zh-TW 内联；其余走 i18n/loader 懒加载，失败时回退到 en）
const translationsData: Record<string, Translations> = {
  en: enTranslations,
  zh: zhTranslations,
  'zh-TW': zhTWTranslations,
};

const I18N_LOAD_TIMEOUT_MS = 12_000;

// 语言上下文
interface LanguageContextType {
  language: Language;
  setLanguage: (lang: Language) => void;
  t: Translations;
  isRTL: boolean;
  isChinese: boolean;
  isTranslationLoading: boolean;
}

const LanguageContext = createContext<LanguageContextType | undefined>(undefined);

// In-memory cache for lazily loaded translations (avoids re-imports)
const _lazyCache = new Map<Language, Translations>();

// Preserve last successfully loaded translations so that a chunk load failure
// (stale SW cache, network hiccup) doesn't permanently fall back to English.
let _lastSuccessT: Translations | null = null;

// SessionStorage cache key for instant language restore on reload
const TRANSLATION_CACHE_KEY = '__taproot_i18n_cache__';
const TRANSLATION_CACHE_LANG_KEY = '__taproot_i18n_cache_lang__';

/**
 * Try to read cached translations from sessionStorage (synchronous).
 * Returns null if not available or language mismatch.
 */
function readCachedTranslations(lang: Language): Translations | null {
  try {
    if (typeof sessionStorage === 'undefined') return null;
    const cachedLang = sessionStorage.getItem(TRANSLATION_CACHE_LANG_KEY);
    if (cachedLang !== lang) return null;
    const raw = sessionStorage.getItem(TRANSLATION_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Translations;
    // Also populate in-memory cache so subsequent reads are instant
    _lazyCache.set(lang, parsed);
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Write translations to sessionStorage for next app launch.
 */
function writeCachedTranslations(lang: Language, t: Translations) {
  try {
    if (typeof sessionStorage === 'undefined') return;
    sessionStorage.setItem(TRANSLATION_CACHE_LANG_KEY, lang);
    sessionStorage.setItem(TRANSLATION_CACHE_KEY, JSON.stringify(t));
  } catch {
    // sessionStorage full or unavailable — silently ignore
  }
}

// Provider组件
export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>(() => {
    if (typeof window !== 'undefined') {
      const saved = storageGet('app-language') as Language;
      if (saved && languages[saved]) {
        return saved;
      }
    }
    return detectBrowserLanguage();
  });

  // Synchronously try sessionStorage cache for the saved language
  // so first render can use correct translations without flash
  const [loadedT, setLoadedT] = useState<Translations | null>(() => {
    if (typeof window === 'undefined') return null;
    const saved = storageGet('app-language') as Language;
    const lang = (saved && languages[saved]) ? saved : detectBrowserLanguage();
    if (lang === 'en') return null; // English: use mergedT from translationsData.en
    const inlineFirst = translationsData[lang];
    if (inlineFirst) return inlineFirst;
    return _lazyCache.get(lang) || readCachedTranslations(lang);
  });

  const [isTranslationLoading, setIsTranslationLoading] = useState(() => {
    if (typeof window === 'undefined') return false;
    const saved = storageGet('app-language') as Language;
    const lang = (saved && languages[saved]) ? saved : detectBrowserLanguage();
    if (lang === 'en') return false;
    if (translationsData[lang]) return false;
    const hasCached = _lazyCache.has(lang);
    return !hasCached;
  });

  const setLanguage = (lang: Language) => {
    setLanguageState(lang);
    if (typeof window !== 'undefined') {
      storageSet('app-language', lang);
      document.documentElement.lang = lang;
      document.documentElement.dir = languages[lang].rtl ? 'rtl' : 'ltr';
    }
  };

  useEffect(() => {
    if (typeof window !== 'undefined') {
      document.documentElement.lang = language;
      document.documentElement.dir = languages[language].rtl ? 'rtl' : 'ltr';
    }
  }, [language]);

  // Lazy-load translations for non-English languages (en/zh/zh-TW 已内联)
  useEffect(() => {
    if (language === 'en') {
      setLoadedT(null);
      setIsTranslationLoading(false);
      // Clear cache when switching to English
      try { sessionStorage.removeItem(TRANSLATION_CACHE_KEY); sessionStorage.removeItem(TRANSLATION_CACHE_LANG_KEY); } catch {}
      return;
    }

    const inlineBuiltin = translationsData[language];
    if (inlineBuiltin) {
      setLoadedT(inlineBuiltin);
      setIsTranslationLoading(false);
      return;
    }

    // Check in-memory cache first (instant)
    const cached = _lazyCache.get(language);
    if (cached) {
      setLoadedT(cached);
      setIsTranslationLoading(false);
      return;
    }

    let cancelled = false;
    setIsTranslationLoading(true);

    const loadWithRetry = async (retries = 2) => {
      try {
        const { loadTranslations } = await import('../i18n/loader');
        return await loadTranslations(language);
      } catch (err) {
        if (retries > 0) {
          console.warn(`[i18n] Loader chunk failed to load, retrying... (${retries} left)`, err);
          await new Promise(resolve => setTimeout(resolve, 500));
          return loadWithRetry(retries - 1);
        }
        throw err;
      }
    };

    const withTimeout = () =>
      Promise.race([
        loadWithRetry(),
        new Promise<Translations | null>((_, reject) => {
          setTimeout(
            () => reject(new Error(`[i18n] load timeout after ${I18N_LOAD_TIMEOUT_MS}ms`)),
            I18N_LOAD_TIMEOUT_MS,
          );
        }),
      ]);

    withTimeout()
      .then((result) => {
        if (cancelled) return;
        if (result) {
          _lastSuccessT = result;
          _lazyCache.set(language, result);
          writeCachedTranslations(language, result);
          setLoadedT(result);
        } else {
          const inline = translationsData[language];
          if (inline) setLoadedT(inline);
        }
      })
      .catch((err) => {
        console.error('[i18n] Error loading translations for', language, err);
        if (cancelled) return;
        // Fallback chain: inline → last successful loadedT → sessionStorage → keep (null = English)
        const inline = translationsData[language];
        if (inline) { setLoadedT(inline); return; }
        if (_lastSuccessT) { setLoadedT(_lastSuccessT); return; }
        const fromStorage = readCachedTranslations(language);
        if (fromStorage) { setLoadedT(fromStorage); return; }
      })
      .finally(() => {
        if (!cancelled) setIsTranslationLoading(false);
      });

    return () => { cancelled = true; };
  }, [language]);

  // Determine current translations
  const fallbackT = translationsData['en'];
  // 内联语言（zh / zh-TW）必须优先于 loadedT，否则从西语等切回中文时仍会短暂用旧包
  const inlineT =
    language === 'en' ? undefined : translationsData[language];
  const currentT =
    language === 'en'
      ? fallbackT
      : (inlineT ?? loadedT ?? fallbackT);

  // Deep merge with English fallback to guarantee no missing keys crash the app
  // This heavily improves frontend resilience when new keys are added to English
  // but translations are not yet updated.
  const mergedT: Translations = {
    ...fallbackT,
    ...currentT,
    common: { ...fallbackT.common, ...(currentT.common || {}) },
    home: { ...fallbackT.home, ...(currentT.home || {}) },
    market: { ...fallbackT.market, ...(currentT.market || {}) },
    community: { ...fallbackT.community, ...(currentT.community || {}) },
    camera: { ...fallbackT.camera, ...(currentT.camera || {}) },
    profile: { ...fallbackT.profile, ...(currentT.profile || {}) },
    settings: { ...fallbackT.settings, ...(currentT.settings || {}) },
    login: { ...fallbackT.login, ...(currentT.login || {}) },
    statement: { ...fallbackT.statement, ...(currentT.statement || {}) },
    ai: { ...fallbackT.ai, ...(currentT.ai || {}) },
    pushNotifications: { ...fallbackT.pushNotifications, ...(currentT.pushNotifications || {}) },
    video: { ...(fallbackT.video || {}), ...(currentT.video || {}) } as Translations['video'],
    desktopIcon: { ...(fallbackT.desktopIcon || {}), ...(currentT.desktopIcon || {}) } as Translations['desktopIcon'],
    configManager: {
      sidebar: { ...(fallbackT.configManager?.sidebar || {}), ...(currentT.configManager?.sidebar || {}) },
      navItems: { ...(fallbackT.configManager?.navItems || {}), ...(currentT.configManager?.navItems || {}) },
      topBar: { ...(fallbackT.configManager?.topBar || {}), ...(currentT.configManager?.topBar || {}) },
      buttons: { ...(fallbackT.configManager?.buttons || {}), ...(currentT.configManager?.buttons || {}) },
      headers: { ...(fallbackT.configManager?.headers || {}), ...(currentT.configManager?.headers || {}) },
      commonLabels: { ...(fallbackT.configManager?.commonLabels || {}), ...(currentT.configManager?.commonLabels || {}) },
      pushNotification: { ...(fallbackT.configManager?.pushNotification || {}), ...(currentT.configManager?.pushNotification || {}) },
      messages: { ...(fallbackT.configManager?.messages || {}), ...(currentT.configManager?.messages || {}) },
    } as Translations['configManager'],
  };

  const value: LanguageContextType = {
    language,
    setLanguage,
    t: mergedT,
    isRTL: languages[language].rtl || false,
    isChinese: language === 'zh' || language === 'zh-TW',
    isTranslationLoading,
  };

  // 不再整页替换为空白：懒加载期间用英文 fallback，否则设置页等无法点击（语言列表都打不开）
  return (
    <LanguageContext.Provider value={value}>
      {children}
    </LanguageContext.Provider>
  );
}

// Hook
export function useLanguage() {
  const context = useContext(LanguageContext);
  if (!context) {
    // Fallback for HMR / Fast Refresh: return English defaults instead of throwing
    // This prevents crashes when the component tree is temporarily without a provider
    const fallbackLanguage: Language = 'en';
    const fallbackT = translationsData[fallbackLanguage];
    return {
      language: fallbackLanguage,
      setLanguage: (_lang: Language) => {
        console.warn('useLanguage: setLanguage called outside LanguageProvider');
      },
      t: {
        ...fallbackT,
        desktopIcon: fallbackT.desktopIcon,
      } as Translations,
      isRTL: false,
      isChinese: false,
      isTranslationLoading: false,
    };
  }
  return context;
}