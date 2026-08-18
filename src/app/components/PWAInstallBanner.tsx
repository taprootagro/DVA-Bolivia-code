import { Download, X, Share } from 'lucide-react';
import { type UseInstallPromptResult } from '../hooks/useInstallPrompt';
import { useLanguage } from '../hooks/useLanguage';
import { useConfigContext } from '../hooks/ConfigProvider';
import { isNative } from '../utils/capacitor-bridge';

type Props = {
  install: UseInstallPromptResult;
};

/**
 * PWA Install Banner — white-label ready
 *
 * - Android/Chrome: triggers native install via beforeinstallprompt
 * - iOS/Safari: guides user to "Share → Add to Home Screen"
 * - Capacitor 原生壳：不展示
 * - App name is read from config (appBranding.appName), never hardcoded
 */
export function PWAInstallBanner({ install }: Props) {
  const { showBanner, platform, triggerInstall, dismiss } = install;
  const { language, isRTL } = useLanguage();
  const { config } = useConfigContext();

  if (isNative()) return null;
  if (!showBanner || !platform) return null;

  const appName = config?.appBranding?.appName || 'App';
  const texts = getTexts(language, appName);

  // Use configured app icon, fall back to generic icon
  const customIcon = config?.desktopIcon?.icon192Url || config?.appBranding?.logoUrl;

  // iOS non-Safari browser detection
  const ua = navigator.userAgent;
  const isIOSNonSafari = platform === 'ios' && /CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);

  const iconElement = customIcon ? (
    <img
      src={customIcon}
      alt=""
      className="w-11 h-11 rounded-xl flex-shrink-0 shadow-sm object-contain p-0.5 bg-white"
    />
  ) : (
    <div className="w-11 h-11 rounded-xl bg-emerald-600 flex items-center justify-center flex-shrink-0 shadow-sm">
      <Download className="w-5 h-5 text-white" />
    </div>
  );

  if (platform === 'ios') {
    return (
      <div className="fixed bottom-20 inset-x-3 z-[60] animate-slide-up">
        <div
          className="rounded-2xl p-4 shadow-2xl border border-gray-100"
          style={{
            background: 'linear-gradient(135deg, #ecfdf5 0%, #ffffff 100%)',
            boxShadow: '0 8px 32px rgba(0,0,0,0.12)',
          }}
        >
          <button
            onClick={dismiss}
            className={`absolute top-3 ${isRTL ? 'left-3' : 'right-3'} w-10 h-10 flex items-center justify-center rounded-full bg-gray-100 active:bg-gray-200`}
            aria-label="Close"
          >
            <X className="w-4 h-4 text-gray-500" />
          </button>

          <div className={`flex items-start gap-3 ${isRTL ? 'pl-8' : 'pr-8'}`}>
            {iconElement}
            <div className="flex-1 min-w-0">
              <p className="text-gray-900" style={{ fontSize: '14px' }}>
                {texts.iosTitle}
              </p>
              {isIOSNonSafari ? (
                <p className="mt-2 text-gray-500" style={{ fontSize: '12px' }}>
                  {texts.iosOpenInSafari}
                </p>
              ) : (
                <div className="flex items-center gap-1.5 mt-2 text-gray-500" style={{ fontSize: '13px' }}>
                  <span>{texts.iosStep1}</span>
                  <Share className="w-4 h-4 text-blue-500 flex-shrink-0" />
                  <span>{texts.iosStep2}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Android / Chrome
  return (
    <div className="fixed bottom-20 inset-x-3 z-[60] animate-slide-up">
      <div
        className="rounded-2xl p-4 shadow-2xl border border-gray-100"
        style={{
          background: 'linear-gradient(135deg, #ecfdf5 0%, #ffffff 100%)',
          boxShadow: '0 8px 32px rgba(0,0,0,0.12)',
        }}
      >
        <div className="flex items-center gap-3">
          {iconElement}
          <div className="flex-1 min-w-0">
            <p className="text-gray-900 truncate" style={{ fontSize: '14px' }}>
              {texts.androidTitle}
            </p>
            <p className="text-gray-500 truncate" style={{ fontSize: '12px' }}>
              {texts.androidDesc}
            </p>
          </div>
          <button
            onClick={triggerInstall}
            className="px-4 py-2 bg-emerald-600 text-white rounded-xl flex-shrink-0 active:bg-emerald-700 transition-colors"
            style={{ fontSize: '13px' }}
          >
            {texts.installBtn}
          </button>
          <button
            onClick={dismiss}
            className="w-10 h-10 flex items-center justify-center rounded-full flex-shrink-0 active:bg-gray-100"
            aria-label="Close"
          >
            <X className="w-4 h-4 text-gray-400" />
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Lightweight i18n — all strings use {name} placeholder replaced at runtime
// ---------------------------------------------------------------------------

interface InstallTexts {
  androidTitle: string;
  androidDesc: string;
  installBtn: string;
  iosTitle: string;
  iosStep1: string;
  iosStep2: string;
  iosOpenInSafari: string;
}

function getTexts(lang: string, appName: string): InstallTexts {
  const templates: Record<string, InstallTexts> = {
    zh: {
      androidTitle: `安装 ${appName} 到桌面`,
      androidDesc: '离线可用，一键启动',
      installBtn: '安装',
      iosTitle: `安装 ${appName} 到主屏幕`,
      iosStep1: '点击底部',
      iosStep2: '→ 添加到主屏幕',
      iosOpenInSafari: '请在 Safari 浏览器中打开此页面',
    },
    'zh-TW': {
      androidTitle: `安裝 ${appName} 到桌面`,
      androidDesc: '離線可用，一鍵啟動',
      installBtn: '安裝',
      iosTitle: `安裝 ${appName} 到主畫面`,
      iosStep1: '點擊底部',
      iosStep2: '→ 加入主畫面',
      iosOpenInSafari: '請在 Safari 瀏覽器中打開此頁面',
    },
    fr: {
      androidTitle: `Installer ${appName}`,
      androidDesc: 'Fonctionne hors ligne',
      installBtn: 'Installer',
      iosTitle: `Ajouter ${appName}`,
      iosStep1: 'Appuyez sur',
      iosStep2: "→ Sur l'écran d'accueil",
      iosOpenInSafari: 'Ouvrez cette page dans Safari',
    },
    es: {
      androidTitle: `Instalar ${appName}`,
      androidDesc: 'Funciona sin conexión',
      installBtn: 'Instalar',
      iosTitle: `Agregar ${appName}`,
      iosStep1: 'Toca',
      iosStep2: '→ Agregar a inicio',
      iosOpenInSafari: 'Abra esta página en Safari',
    },
    pt: {
      androidTitle: `Instalar ${appName}`,
      androidDesc: 'Funciona offline',
      installBtn: 'Instalar',
      iosTitle: `Adicionar ${appName}`,
      iosStep1: 'Toque em',
      iosStep2: '→ Tela de Início',
      iosOpenInSafari: 'Abra esta página no Safari',
    },
    ar: {
      androidTitle: `تثبيت ${appName}`,
      androidDesc: 'يعمل بدون إنترنت',
      installBtn: 'تثبيت',
      iosTitle: `أضف ${appName} للشاشة`,
      iosStep1: 'اضغط على',
      iosStep2: '← إضافة للشاشة الرئيسية',
      iosOpenInSafari: 'افتح هذه الصفحة في Safari',
    },
    hi: {
      androidTitle: `${appName} इंस्टॉल करें`,
      androidDesc: 'ऑफलाइन भी चलता है',
      installBtn: 'इंस्टॉल',
      iosTitle: `${appName} होम स्क्रीन पर जोड़ें`,
      iosStep1: 'नीचे',
      iosStep2: '→ होम स्क्रीन पर जोड़ें',
      iosOpenInSafari: 'इस पेज को Safari में खोलें',
    },
    ru: {
      androidTitle: `Установить ${appName}`,
      androidDesc: 'Работает офлайн',
      installBtn: 'Установить',
      iosTitle: `Добавить ${appName}`,
      iosStep1: 'Нажмите',
      iosStep2: '→ На экран «Домой»',
      iosOpenInSafari: 'Откройте эту страницу в Safari',
    },
    bn: {
      androidTitle: `${appName} ইনস্টল করুন`,
      androidDesc: 'অফলাইনে কাজ করে',
      installBtn: 'ইনস্টল',
      iosTitle: `${appName} হোম স্ক্রিনে যোগ করুন`,
      iosStep1: 'নিচে',
      iosStep2: '→ হোম স্ক্রিনে যোগ করুন',
      iosOpenInSafari: 'এই পেজটি Safari-তে খুলুন',
    },
    ur: {
      androidTitle: `${appName} انسٹال کریں`,
      androidDesc: 'آف لائن کام کرتا ہے',
      installBtn: 'انسٹال',
      iosTitle: `${appName} ہوم اسکرین پر شامل کریں`,
      iosStep1: 'نیچے دبائیں',
      iosStep2: '← ہوم اسکرین میں شامل کریں',
      iosOpenInSafari: 'اس صفحے کو Safari میں کھولیں',
    },
    id: {
      androidTitle: `Pasang ${appName}`,
      androidDesc: 'Bisa offline, buka cepat',
      installBtn: 'Pasang',
      iosTitle: `Tambah ${appName} ke Layar Utama`,
      iosStep1: 'Ketuk',
      iosStep2: '→ Tambahkan ke Layar Utama',
      iosOpenInSafari: 'Buka halaman ini di Safari',
    },
    vi: {
      androidTitle: `Cài đặt ${appName}`,
      androidDesc: 'Hoạt động ngoại tuyến',
      installBtn: 'Cài đặt',
      iosTitle: `Thêm ${appName} vào Màn hình chính`,
      iosStep1: 'Nhấn',
      iosStep2: '→ Thêm vào Màn hình chính',
      iosOpenInSafari: 'Mở trang này trong Safari',
    },
    ms: {
      androidTitle: `Pasang ${appName}`,
      androidDesc: 'Boleh guna luar talian',
      installBtn: 'Pasang',
      iosTitle: `Tambah ${appName} ke Skrin Utama`,
      iosStep1: 'Ketik',
      iosStep2: '→ Tambah ke Skrin Utama',
      iosOpenInSafari: 'Buka halaman ini di Safari',
    },
    ja: {
      androidTitle: `${appName} をインストール`,
      androidDesc: 'オフラインでも使えます',
      installBtn: 'インストール',
      iosTitle: `${appName} をホーム画面に追加`,
      iosStep1: '下の',
      iosStep2: '→ ホーム画面に追加',
      iosOpenInSafari: 'このページを Safari で開いてください',
    },
    th: {
      androidTitle: `ติดตั้ง ${appName}`,
      androidDesc: 'ใช้งานออฟไลน์ได้',
      installBtn: 'ติดตั้ง',
      iosTitle: `เพิ่ม ${appName} ไปยังหน้าจอหลัก`,
      iosStep1: 'แตะ',
      iosStep2: '→ เพิ่มไปยังหน้าจอหลัก',
      iosOpenInSafari: 'เปิดหน้านี้ใน Safari',
    },
    my: {
      androidTitle: `${appName} ထည့်သွင်းပါ`,
      androidDesc: 'အော့ဖ်လိုင်းသုံးနိုင်သည်',
      installBtn: 'ထည့်သွင်း',
      iosTitle: `${appName} ကို ပင်မစခရင်သို့ ထည့်ပါ`,
      iosStep1: 'အောက်ခြေ',
      iosStep2: '→ ပင်မစခရင်သို့ ထည့်ပါ',
      iosOpenInSafari: 'ဒီစာမျက်နှာကို Safari တွင် ဖွင့်ပါ',
    },
    tl: {
      androidTitle: `I-install ang ${appName}`,
      androidDesc: 'Gumagana offline',
      installBtn: 'I-install',
      iosTitle: `Idagdag ang ${appName} sa Home Screen`,
      iosStep1: 'Pindutin',
      iosStep2: '→ Idagdag sa Home Screen',
      iosOpenInSafari: 'Buksan ang pahinang ito sa Safari',
    },
    tr: {
      androidTitle: `${appName}'yu Yükle`,
      androidDesc: 'Çevrimdışı çalışır',
      installBtn: 'Yükle',
      iosTitle: `${appName}'yu Ana Ekrana Ekle`,
      iosStep1: 'Dokunun',
      iosStep2: '→ Ana Ekrana Ekle',
      iosOpenInSafari: 'Bu sayfayı Safari ile açın',
    },
    fa: {
      androidTitle: `نصب ${appName}`,
      androidDesc: 'بدون اینترنت کار می‌کند',
      installBtn: 'نصب',
      iosTitle: `افزودن ${appName} به صفحه اصلی`,
      iosStep1: 'روی',
      iosStep2: '← افزودن به صفحه اصلی',
      iosOpenInSafari: 'این صفحه را در Safari باز کنید',
    },
  };

  return templates[lang] || {
    androidTitle: `Install ${appName}`,
    androidDesc: 'Works offline, fast launch',
    installBtn: 'Install',
    iosTitle: `Add ${appName} to Home Screen`,
    iosStep1: 'Tap',
    iosStep2: '→ Add to Home Screen',
    iosOpenInSafari: 'Open this page in Safari browser',
  };
}
