import { defineConfig } from 'vite'
import path from 'path'
import { cpSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { execSync, spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import sharp from 'sharp'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'

/** Fetch remote image and write exact WxH PNG (for PWA manifest icons). */
async function fetchResizePng(
  imageUrl: string,
  size: number,
  outPath: string,
  log: (msg: string) => void,
): Promise<boolean> {
  try {
    const res = await fetch(imageUrl)
    if (!res.ok) {
      log(`[taprootagro-config-save] fetch ${size}px failed: ${res.status}`)
      return false
    }
    const buf = Buffer.from(await res.arrayBuffer())
    await sharp(buf)
      .resize(size, size, { fit: 'cover' })
      .png()
      .toFile(outPath)
    return true
  } catch (e) {
    log(`[taprootagro-config-save] resize ${size}px: ${e}`)
    return false
  }
}

export default defineConfig({
  // 内容管理器「保存」会 POST 到 /__taprootagro/config/save 并写回 taprootagrosetting/*.json
  // 与 PWA 相关的 public/ 资源；若监视这些文件，Vite 会对已 import 的 JSON 全页刷新，像「闪一下重启」。
  // 开发时改 taprootagrosetting/ 可手动整页刷新；勿移除 mirrorDevFiles（无此忽略则每点保存就整页重载）。
  server: {
    watch: {
      ignored: [
        '**/taprootagrosetting/**',
        '**/public/icon-192.png',
        '**/public/icon-512.png',
        '**/public/manifest.json',
      ],
    },
  },
  // Force Vite restart
  plugins: [
    // The React and Tailwind plugins are both required for Make, even if
    // Tailwind is not being actively used – do not remove them
    react(),
    tailwindcss(),
    {
      name: 'taprootagro-config-save',
      apply: 'serve',
      configureServer(server) {
        server.middlewares.use('/__taprootagro/config/save', async (req, res) => {
          try {
            if (req.method !== 'POST') {
              res.statusCode = 405;
              res.setHeader('Content-Type', 'application/json; charset=utf-8');
              res.end(JSON.stringify({ ok: false, error: 'Method not allowed' }));
              return;
            }

            const contentType = String(req.headers['content-type'] || '');
            if (!contentType.includes('application/json')) {
              res.statusCode = 415;
              res.setHeader('Content-Type', 'application/json; charset=utf-8');
              res.end(JSON.stringify({ ok: false, error: 'Expected application/json' }));
              return;
            }

            const chunks: Buffer[] = [];
            await new Promise<void>((resolve, reject) => {
              req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
              req.on('end', () => resolve());
              req.on('error', reject);
            });

            const bodyText = Buffer.concat(chunks).toString('utf8');
            const body = JSON.parse(bodyText || '{}') as { config?: any };
            const cfg = body?.config;
            if (!cfg || typeof cfg !== 'object') {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json; charset=utf-8');
              res.end(JSON.stringify({ ok: false, error: 'Missing config object' }));
              return;
            }

            const settingDir = path.resolve(__dirname, './taprootagrosetting');
            const readJson = async (fileName: string) => {
              try {
                const filePath = path.join(settingDir, fileName);
                const txt = await fs.readFile(filePath, 'utf8');
                return JSON.parse(txt);
              } catch {
                return {};
              }
            };
            const writeJson = async (fileName: string, data: any) => {
              const filePath = path.join(settingDir, fileName);
              const json = JSON.stringify(data, null, 2) + '\n';
              await fs.writeFile(filePath, json, 'utf8');
            };

            const [
              homeExisting,
              marketExisting,
              appExisting,
              chatExisting,
              legalExisting,
              aiExisting,
              pushExisting,
              authExisting,
              liveExisting,
              backendExisting,
            ] = await Promise.all([
              readJson('home.json'),
              readJson('market.json'),
              readJson('app.json'),
              readJson('chat.json'),
              readJson('legal.json'),
              readJson('ai.json'),
              readJson('push.json'),
              readJson('auth.json'),
              readJson('live.json'),
              readJson('backend.json'),
            ]);

            await Promise.all([
              writeJson('home.json', {
                banners: typeof cfg.banners !== 'undefined' ? cfg.banners : (homeExisting as any).banners ?? [],
                navigation: typeof cfg.navigation !== 'undefined' ? cfg.navigation : (homeExisting as any).navigation ?? [],
                liveStreams: typeof cfg.liveStreams !== 'undefined' ? cfg.liveStreams : (homeExisting as any).liveStreams ?? [],
                articles: typeof cfg.articles !== 'undefined' ? cfg.articles : (homeExisting as any).articles ?? [],
                videoFeed: typeof cfg.videoFeed !== 'undefined' ? cfg.videoFeed : (homeExisting as any).videoFeed ?? { title: '', description: '', videoSources: [] },
                homeIcons: typeof cfg.homeIcons !== 'undefined' ? cfg.homeIcons : (homeExisting as any).homeIcons ?? {
                  aiAssistantIconUrl: '',
                  aiAssistantLabel: '',
                  statementIconUrl: '',
                  statementLabel: '',
                  liveCoverUrl: '',
                  liveTitle: '',
                  liveBadge: '',
                },
              }),
              writeJson('market.json', {
                currencySymbol: typeof cfg.currencySymbol !== 'undefined' ? cfg.currencySymbol : (marketExisting as any).currencySymbol ?? '¥',
                marketPage: typeof cfg.marketPage !== 'undefined' ? cfg.marketPage : (marketExisting as any).marketPage ?? { categories: [], products: [], advertisements: [] },
              }),
              writeJson('app.json', {
                profileEditCooldownSeconds:
                  typeof cfg.profileEditCooldownSeconds === 'number'
                    ? cfg.profileEditCooldownSeconds
                    : (appExisting as any).profileEditCooldownSeconds ?? 300,
                appBranding: typeof cfg.appBranding !== 'undefined' ? cfg.appBranding : (appExisting as any).appBranding ?? { logoUrl: '', appName: '', slogan: '' },
                splashScreen: typeof cfg.splashScreen !== 'undefined' ? cfg.splashScreen : (appExisting as any).splashScreen ?? { imageUrl: '', minDisplayMs: 2000, maxResourceWaitMs: 4000, showSkipButton: true },
                desktopIcon: typeof cfg.desktopIcon !== 'undefined' ? cfg.desktopIcon : (appExisting as any).desktopIcon ?? { appName: '', icon192Url: '', icon512Url: '' },
                filing: typeof cfg.filing !== 'undefined' ? cfg.filing : (appExisting as any).filing ?? { icpNumber: '', icpUrl: '', policeNumber: '', policeUrl: '' },
              }),
              writeJson('chat.json', {
                communityUiMode: typeof cfg.communityUiMode !== 'undefined' ? cfg.communityUiMode : (chatExisting as any).communityUiMode ?? 'farmer',
                chatContact: typeof cfg.chatContact !== 'undefined' ? cfg.chatContact : (chatExisting as any).chatContact ?? {
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
                userProfile: typeof cfg.userProfile !== 'undefined' ? cfg.userProfile : (chatExisting as any).userProfile ?? { name: '', avatar: '' },
              }),
              writeJson('legal.json', {
                aboutUs: typeof cfg.aboutUs !== 'undefined' ? cfg.aboutUs : (legalExisting as any).aboutUs ?? { title: '', content: '' },
                privacyPolicy: typeof cfg.privacyPolicy !== 'undefined' ? cfg.privacyPolicy : (legalExisting as any).privacyPolicy ?? { title: '', content: '' },
                termsOfService: typeof cfg.termsOfService !== 'undefined' ? cfg.termsOfService : (legalExisting as any).termsOfService ?? { title: '', content: '' },
                technicalSupport: typeof cfg.technicalSupport !== 'undefined' ? cfg.technicalSupport : (legalExisting as any).technicalSupport ?? { title: '', content: '' },
              }),
              writeJson('ai.json', {
                aiModelConfig: typeof cfg.aiModelConfig !== 'undefined' ? cfg.aiModelConfig : (aiExisting as any).aiModelConfig ?? { modelUrl: '', labelsUrl: '', enableLocalModel: false },
                cloudAIConfig: typeof cfg.cloudAIConfig !== 'undefined' ? cfg.cloudAIConfig : (aiExisting as any).cloudAIConfig ?? {
                  enabled: false,
                  providerName: '',
                  edgeFunctionName: 'ai-vision-proxy',
                  modelId: '',
                  systemPrompt: '',
                  maxTokens: 512,
                  supabaseUrl: '',
                  supabaseAnonKey: '',
                },
              }),
              writeJson('push.json', {
                pushConfig: typeof cfg.pushConfig !== 'undefined' ? cfg.pushConfig : (pushExisting as any).pushConfig ?? { vapidPublicKey: '', pushApiBase: '', enabled: false },
                pushProvidersConfig: typeof cfg.pushProvidersConfig !== 'undefined' ? cfg.pushProvidersConfig : (pushExisting as any).pushProvidersConfig ?? {
                  activeProvider: 'webpush',
                  webpush: { enabled: false, vapidPublicKey: '', pushApiBase: '' },
                  fcm: { enabled: false, apiKey: '', projectId: '', appId: '', messagingSenderId: '', vapidKey: '' },
                  onesignal: { enabled: false, appId: '', safariWebId: '' },
                  jpush: { enabled: false, appKey: '', masterSecret: '', channel: '', pushApiBase: '' },
                  getui: { enabled: false, appId: '', appKey: '', masterSecret: '', pushApiBase: '' },
                },
              }),
              writeJson('auth.json', {
                loginConfig: typeof cfg.loginConfig !== 'undefined' ? cfg.loginConfig : (authExisting as any).loginConfig ?? {
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
              }),
              writeJson('live.json', {
                liveShareConfig: typeof cfg.liveShareConfig !== 'undefined' ? cfg.liveShareConfig : (liveExisting as any).liveShareConfig ?? {
                  enabled: false,
                  shareUrl: '',
                  shareTitle: '',
                  shareText: '',
                  shareImgUrl: '',
                  wxJsSdkEnabled: false,
                  wxAppId: '',
                  wxSignatureApi: '',
                },
                liveNavigationConfig: typeof cfg.liveNavigationConfig !== 'undefined' ? cfg.liveNavigationConfig : (liveExisting as any).liveNavigationConfig ?? {
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
              }),
              writeJson('backend.json', {
                backendProxyConfig: typeof cfg.backendProxyConfig !== 'undefined' ? cfg.backendProxyConfig : (backendExisting as any).backendProxyConfig ?? {
                  supabaseUrl: '',
                  supabaseAnonKey: '',
                  edgeFunctionName: 'server',
                  enabled: false,
                  chatProvider: 'tencent-im',
                  imMode: 'im-provider-direct',
                  tencentAppId: '',
                  cometchatAppId: '',
                  cometchatRegion: '',
                },
              }),
            ]);

            // PWA: resize icons to exact 192/512 → public/*.png + update manifest.json (same-origin, no blob)
            const publicDir = path.resolve(__dirname, './public');
            const manifestPath = path.join(publicDir, 'manifest.json');
            const desktopIcon = cfg.desktopIcon as { appName?: string; icon192Url?: string; icon512Url?: string } | undefined;
            const appBranding = cfg.appBranding as { appName?: string } | undefined;
            const displayName = desktopIcon?.appName || appBranding?.appName;
            const u192 = desktopIcon?.icon192Url;
            const u512 = desktopIcon?.icon512Url;
            const log = (m: string) => server.config.logger.warn(m);
            const p192 = path.join(publicDir, 'icon-192.png');
            const p512 = path.join(publicDir, 'icon-512.png');

            let have192 = false;
            let have512 = false;
            if (u192?.startsWith('http')) {
              have192 = await fetchResizePng(u192, 192, p192, log);
            }
            if (u512?.startsWith('http')) {
              have512 = await fetchResizePng(u512, 512, p512, log);
            }
            if (have192 && !have512) {
              try {
                await sharp(p192).resize(512, 512, { fit: 'cover' }).png().toFile(p512);
                have512 = true;
                server.config.logger.info('[taprootagro-config-save] icon-512.png generated from 192 source');
              } catch (e) {
                log(`[taprootagro-config-save] derive 512 from 192: ${e}`);
              }
            } else if (have512 && !have192) {
              try {
                await sharp(p512).resize(192, 192, { fit: 'cover' }).png().toFile(p192);
                have192 = true;
                server.config.logger.info('[taprootagro-config-save] icon-192.png generated from 512 source');
              } catch (e) {
                log(`[taprootagro-config-save] derive 192 from 512: ${e}`);
              }
            }

            const iconsOk = have192 && have512;
            if (displayName || iconsOk) {
              try {
                const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
                if (displayName) {
                  manifest.name = displayName;
                  manifest.short_name = displayName;
                }
                if (iconsOk) {
                  manifest.icons = [
                    { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
                    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
                    { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
                    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
                  ];
                }
                await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
                server.config.logger.info('[taprootagro-config-save] manifest.json updated');
              } catch (e) {
                server.config.logger.warn(`[taprootagro-config-save] manifest.json update failed: ${e}`);
              }
            }

            const seedSync = spawnSync(
              process.execPath,
              [path.resolve(__dirname, 'scripts/generate-seed-sql.mjs'), '--write-init'],
              { cwd: path.resolve(__dirname), encoding: 'utf8' },
            );
            if (seedSync.status !== 0) {
              server.config.logger.warn(
                `[taprootagro-config-save] app_config seed sync failed: ${seedSync.stderr || seedSync.stdout || seedSync.status}`,
              );
            } else {
              server.config.logger.info('[taprootagro-config-save] synced supabase/migrations/001_init.sql app_config seed');
            }

            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: true }));
          } catch (err) {
            server.config.logger.error(`[taprootagro-config-save] ${String(err)}`);
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ ok: false, error: 'Failed to save config JSON files' }));
          }
        });
      },
    },
    {
      name: 'taprootagro-copy-settings',
      apply: 'build',
      writeBundle() {
        cpSync(
          path.resolve(__dirname, './taprootagrosetting'),
          path.resolve(__dirname, './dist/taprootagrosetting'),
          { recursive: true },
        );
      },
    },
    {
      name: 'taprootagro-stamp-sw-version',
      apply: 'build',
      closeBundle() {
        let gitHash = 'local';
        try {
          gitHash = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
        } catch {
          /* not a git repo or git unavailable */
        }
        const cacheVersion = `v-${gitHash}-${Date.now().toString(36)}`;
        const stampFile = (filePath: string) => {
          if (!existsSync(filePath)) return;
          const content = readFileSync(filePath, 'utf8');
          const next = content.replace(
            /const CACHE_VERSION = '[^']*';/,
            `const CACHE_VERSION = '${cacheVersion}';`,
          );
          if (next !== content) {
            writeFileSync(filePath, next, 'utf8');
          }
        };
        stampFile(path.resolve(__dirname, './dist/service-worker.js'));
      },
    },
    {
      name: 'taprootagro-native-build',
      apply: 'build',
      closeBundle() {
        if (process.env.VITE_NATIVE_BUILD !== '1') return;
        const swPath = path.resolve(__dirname, './dist/service-worker.js');
        if (existsSync(swPath)) {
          unlinkSync(swPath);
        }
      },
    },
  ],
  resolve: {
    alias: {
      // Alias @ to the src directory
      '@': path.resolve(__dirname, './src'),
      // Alias /taprootagrosetting to the config directory
      '/taprootagrosetting': path.resolve(__dirname, './taprootagrosetting'),
    },
  },

  // File types to support raw imports. Never add .css, .tsx, or .ts files to this.
  assetsInclude: ['**/*.svg', '**/*.csv'],

  // 构建优化
  build: {
    // 显式声明输出目录（Vite 默认值），确保部署平台自动检测
    outDir: 'dist',
    rollupOptions: {
      // PWA 浏览器包不加载 capacitor-loader，external 无影响。
      // VITE_NATIVE_BUILD=1 时 loader 会 static import @capacitor/app，必须打进 bundle。
      external: process.env.VITE_NATIVE_BUILD === '1' ? [] : ['@capacitor/app'],
      output: {
        manualChunks(id: string) {
          // React 核心库
          if (id.includes('react-dom') || id.includes('react-router') || (id.includes('/react/') && !id.includes('react-'))) {
            return 'react-vendor';
          }
          // UI 图标库
          if (id.includes('lucide-react')) {
            return 'ui-vendor';
          }
          // 国际化（最大单文件，��立分包）
          if (id.includes('useLanguage')) {
            return 'i18n';
          }
        },
      },
    },
    minify: 'terser',
    terserOptions: {
      compress: {
        // 生产环境移除 console.log/warn，保留 console.error
        drop_console: true,
        pure_funcs: ['console.log', 'console.warn', 'console.info', 'console.group', 'console.groupEnd'],
        drop_debugger: true,
      },
    },
    chunkSizeWarningLimit: 1000,
    // 启用 CSS 代码分割
    cssCodeSplit: true,
  },
})