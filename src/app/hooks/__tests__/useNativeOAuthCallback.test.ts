import { describe, expect, it } from 'vitest';
import {
  nativeOAuthRedirectTo,
  oauthCallbackRouteFromUrl,
  readNativeAppId,
} from '../../hooks/useNativeOAuthCallback';

describe('oauthCallbackRouteFromUrl', () => {
  it('parses full https localhost callback', () => {
    expect(
      oauthCallbackRouteFromUrl('https://localhost/auth/callback?code=abc&state=xyz'),
    ).toBe('/auth/callback?code=abc&state=xyz');
  });

  it('parses package scheme callback with code', () => {
    expect(
      oauthCallbackRouteFromUrl('com.dva_agro.bolivia://auth/callback?code=abc&state=xyz'),
    ).toBe('/auth/callback?code=abc&state=xyz');
  });

  it('parses package scheme callback with error', () => {
    expect(
      oauthCallbackRouteFromUrl('com.dva_agro.bolivia://auth/callback?error=access_denied'),
    ).toBe('/auth/callback?error=access_denied');
  });

  it('parses relative callback path', () => {
    expect(oauthCallbackRouteFromUrl('/auth/callback?code=1')).toBe('/auth/callback?code=1');
  });

  it('returns null for unrelated URLs', () => {
    expect(oauthCallbackRouteFromUrl('https://example.com/home')).toBeNull();
    expect(oauthCallbackRouteFromUrl('com.dva_agro.bolivia://home')).toBeNull();
  });
});

describe('nativeOAuthRedirectTo', () => {
  it('uses web origin when not native', () => {
    expect(nativeOAuthRedirectTo()).toMatch(/\/auth\/callback$/);
    expect(nativeOAuthRedirectTo()).not.toContain('localhost://');
  });

  it('does not use https origin on native even if getConfig().appId is missing', () => {
    (window as any).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'android',
    };
    expect(readNativeAppId()).toBeNull();
    expect(nativeOAuthRedirectTo()).toBe('');
    delete (window as any).Capacitor;
  });

  it('uses Capacitor.Config.appId on native', () => {
    (window as any).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'android',
      Config: { appId: 'com.dva_agro.bolivia' },
    };
    expect(nativeOAuthRedirectTo()).toBe('com.dva_agro.bolivia://auth/callback');
    delete (window as any).Capacitor;
  });
});
