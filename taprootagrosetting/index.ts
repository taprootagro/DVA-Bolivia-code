/**
 * TaprootAgro 配置聚合器（母版 / 底层兜底）
 *
 * 从各模块 JSON 组装 `defaultConfig`，与内容管理器「出厂」数据一致。
 * 运行时优先级：JSON 默认值 (最低) → localStorage 用户编辑 (最高)；
 * ConfigProvider 的 deepMerge 负责合并。
 *
 * **与云端种子同步**：修改 `taprootagrosetting/*.json` 后，在项目根执行
 * `node scripts/generate-seed-sql.mjs --write-init`（或 `npm run sync:app-config-seed`）。
 * 开发模式下内容管理器「保存到本机」写回 JSON 后会**自动**执行上述命令。
 *
 * 分发母版：复制整个 `/taprootagrosetting/` 文件夹即可带走默认 CMS 配置骨架。
 */

import type { HomePageConfig } from '../src/app/hooks/useHomeConfig';

// --- 导入各模块 JSON ---
import appJson from './app.json';
import homeJson from './home.json';
import marketJson from './market.json';
import chatJson from './chat.json';
import legalJson from './legal.json';
import aiJson from './ai.json';
import pushJson from './push.json';
import authJson from './auth.json';
import liveJson from './live.json';
import backendJson from './backend.json';

/**
 * 完整的出厂默认配置
 * ConfigManager / `resetConfig` 会还原到这组值（仅写入 localStorage `agri_home_config`；不登出、不清 Supabase 会话）。
 *
 * 安全：不得在此提交任何真实项目 URL、anon key、Service Role 或写密钥。运营环境在内容管理页或合并后的本机配置中填写。
 */
export const defaultConfig: HomePageConfig = {
  // --- home.json ---
  banners: homeJson.banners,
  navigation: homeJson.navigation,
  liveStreams: homeJson.liveStreams,
  articles: homeJson.articles,
  videoFeed: homeJson.videoFeed,
  homeIcons: homeJson.homeIcons,

  // --- market.json ---
  currencySymbol: marketJson.currencySymbol,
  marketPage: marketJson.marketPage,

  // --- app.json ---
  profileEditCooldownSeconds:
    typeof (appJson as { profileEditCooldownSeconds?: unknown }).profileEditCooldownSeconds ===
    'number'
      ? Math.max(
          0,
          Math.floor((appJson as { profileEditCooldownSeconds: number }).profileEditCooldownSeconds),
        )
      : 300,
  appBranding: appJson.appBranding,
  splashScreen: appJson.splashScreen as HomePageConfig['splashScreen'],
  desktopIcon: appJson.desktopIcon,
  filing: appJson.filing,

  // --- chat.json ---
  chatContact: chatJson.chatContact as HomePageConfig['chatContact'],
  communityUiMode: (chatJson as { communityUiMode?: 'farmer' | 'store' }).communityUiMode ?? 'farmer',
  userProfile: chatJson.userProfile,

  // --- legal.json ---
  aboutUs: legalJson.aboutUs,
  privacyPolicy: legalJson.privacyPolicy,
  termsOfService: legalJson.termsOfService,
  technicalSupport: legalJson.technicalSupport,

  // --- ai.json ---
  aiModelConfig: aiJson.aiModelConfig,
  cloudAIConfig: aiJson.cloudAIConfig,

  // --- push.json ---
  pushConfig: pushJson.pushConfig,
  pushProvidersConfig: pushJson.pushProvidersConfig as HomePageConfig['pushProvidersConfig'],

  // --- auth.json ---
  loginConfig: authJson.loginConfig as HomePageConfig['loginConfig'],

  // --- live.json ---
  liveShareConfig: liveJson.liveShareConfig,
  liveNavigationConfig: liveJson.liveNavigationConfig as HomePageConfig['liveNavigationConfig'],

  // --- backend.json ---
  backendProxyConfig: backendJson.backendProxyConfig as HomePageConfig['backendProxyConfig'],
};
