import { browserSupportsWebAuthn } from '@simplewebauthn/browser';

/**
 * StarMoe: in-app browsers that expose the WebAuthn API but cannot actually create a passkey.
 *
 * - iOS/iPadOS apps embed WKWebView, which only allows WebAuthn for apps with Apple's browser
 *   entitlement or associated domains. Its user agent drops the `Safari/` token that Safari, Chrome,
 *   Firefox and Edge on iOS all send. (QQ 9.3 on iOS 26: `PublicKeyCredential` exists, but creating a
 *   passkey fails.)
 * - Android `WebView` (`; wv)`) needs the host app to opt in, which most apps do not.
 * - Well-known chat and social apps are listed too, in case their user agent hides the above.
 */
const appInAppBrowserPattern =
  /micromessenger\/|(?:^|[^a-z])qq\/\d|weibo|dingtalk|lark\/|feishu|alipayclient|fban\/|fbav\/|instagram|core\/wkwebview/i;

export const isEmbeddedWebView = (userAgent: string): boolean => {
  if (appInAppBrowserPattern.test(userAgent)) {
    return true;
  }

  if (/\b(?:iphone|ipad|ipod)\b/i.test(userAgent)) {
    return /applewebkit\//i.test(userAgent) && !/\bsafari\//i.test(userAgent);
  }

  return /;\s*wv\)/i.test(userAgent);
};

/** Whether this browser can create a passkey, so that suggesting one makes sense. */
export const canCreatePasskey = (): boolean =>
  browserSupportsWebAuthn() && !isEmbeddedWebView(window.navigator.userAgent);
