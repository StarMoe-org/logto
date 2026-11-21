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

// StarMoe: browsers without WebAuthn (e.g. QQ's in-app browser) skip the passkey suggestion for this
// sign-in instead of showing a dead-end error page.
describe('PasskeySetup', () => {
  afterEach(() => {
    jest.clearAllMocks();
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
