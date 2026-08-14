import { describe, expect, it } from 'vitest';
import { oauthCallbackRouteFromUrl } from '../../hooks/useNativeOAuthCallback';

describe('oauthCallbackRouteFromUrl', () => {
  it('parses full https localhost callback', () => {
    expect(
      oauthCallbackRouteFromUrl('https://localhost/auth/callback?code=abc&state=xyz'),
    ).toBe('/auth/callback?code=abc&state=xyz');
  });

  it('parses relative callback path', () => {
    expect(oauthCallbackRouteFromUrl('/auth/callback?code=1')).toBe('/auth/callback?code=1');
  });

  it('returns null for unrelated URLs', () => {
    expect(oauthCallbackRouteFromUrl('https://example.com/home')).toBeNull();
  });
});
