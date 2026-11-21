import { waitFor } from '@testing-library/react';

import renderWithPageContext from '@/__mocks__/RenderWithPageContext';
import { createSignInPasskeyRegistrationOptions, skipPasskeyBinding } from '@/apis/experience';

import PasskeySetup from '.';

const mockBrowserSupportsWebAuthn = jest.fn(() => true);
const mockRedirectTo = jest.fn();

// Same stubs as jest.setup.ts, with a controllable `browserSupportsWebAuthn`.
jest.mock('@simplewebauthn/browser', () => ({
  __esModule: true,
  WebAuthnAbortService: class WebAuthnAbortService {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    abort() {}
  },
  WebAuthnError: class WebAuthnError extends Error {},
  browserSupportsWebAuthn: () => mockBrowserSupportsWebAuthn(),
  browserSupportsWebAuthnAutofill: () => true,
  platformAuthenticatorIsAvailable: async () => true,
  startAuthentication: async () => ({}),
  startRegistration: async () => ({}),
}));

jest.mock('@/apis/experience', () => ({
  createSignInPasskeyRegistrationOptions: jest.fn(async () => ({
    verificationId: 'verification-id',
    options: {},
  })),
  skipPasskeyBinding: jest.fn(async () => ({ redirectTo: '/callback' })),
}));

jest.mock('@/hooks/use-global-redirect-to', () => ({
  __esModule: true,
  default: () => mockRedirectTo,
}));

// StarMoe: browsers that cannot create a passkey (no WebAuthn, or in-app browsers such as QQ's) skip
// the passkey suggestion for this sign-in instead of showing it.
describe('PasskeySetup', () => {
  afterEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  it('skips the suggestion for this sign-in only when WebAuthn is not supported', async () => {
    mockBrowserSupportsWebAuthn.mockReturnValue(false);
    const { queryByText } = renderWithPageContext(<PasskeySetup />, {
      initialEntries: ['/create-passkey'],
    });

    await waitFor(() => {
      expect(mockRedirectTo).toHaveBeenCalledWith('/callback');
    });
    expect(skipPasskeyBinding).toHaveBeenCalledTimes(1);
    expect(skipPasskeyBinding).toHaveBeenCalledWith(true);
    expect(createSignInPasskeyRegistrationOptions).not.toHaveBeenCalled();
    expect(queryByText('passkey_sign_in.setup_page.title')).toBeNull();
    expect(queryByText('mfa.webauthn_not_supported')).toBeNull();
  });

  it('skips the suggestion in in-app browsers that expose but block WebAuthn', async () => {
    mockBrowserSupportsWebAuthn.mockReturnValue(true);
    jest
      .spyOn(window.navigator, 'userAgent', 'get')
      .mockReturnValue(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 QQ/9.3.86.617 Core/WKWebView'
      );
    const { queryByText } = renderWithPageContext(<PasskeySetup />, {
      initialEntries: ['/create-passkey'],
    });

    await waitFor(() => {
      expect(mockRedirectTo).toHaveBeenCalledWith('/callback');
    });
    expect(skipPasskeyBinding).toHaveBeenCalledWith(true);
    expect(createSignInPasskeyRegistrationOptions).not.toHaveBeenCalled();
    expect(queryByText('passkey_sign_in.setup_page.title')).toBeNull();
  });

  it('shows the suggestion when WebAuthn is supported', async () => {
    mockBrowserSupportsWebAuthn.mockReturnValue(true);
    const { queryByText } = renderWithPageContext(<PasskeySetup />, {
      initialEntries: ['/create-passkey'],
    });

    await waitFor(() => {
      expect(createSignInPasskeyRegistrationOptions).toHaveBeenCalled();
    });
    expect(queryByText('passkey_sign_in.setup_page.title')).not.toBeNull();
    expect(skipPasskeyBinding).not.toHaveBeenCalled();
  });
});
