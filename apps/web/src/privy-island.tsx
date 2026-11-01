/**
 * Privy login island: the only React in the Maze PWA.
 *
 * The Lit shell owns the app. This module mounts the auth buttons into
 * #privy-island only when the welcome screen is active. In e2e, the legacy
 * window.MazePrivy.login bridge is still honored; in configured builds the
 * buttons run Privy Google OAuth or headless email-code login through the
 * React SDK — no Privy modal, the welcome screen stays ours.
 *
 * Failure honesty: if the Privy embed never becomes ready (content blocker,
 * CSP, outage) the island says so and offers a real retry (full remount)
 * instead of leaving a dead button on the only door into the product.
 */

import { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  PrivyProvider,
  useLoginWithEmail,
  useLoginWithOAuth,
  usePrivy,
  useSessionSigners,
} from '@privy-io/react-auth';

const PRIVY_APP_ID = (import.meta.env.VITE_PRIVY_APP_ID ?? '').trim();
const PRIVY_CLIENT_ID = (import.meta.env.VITE_PRIVY_CLIENT_ID ?? '').trim();

/**
 * Server-signing delegation: the NEXA backend holds a Privy authorization key
 * (id below) so it can sign trades/swaps/deposits on the user's behalf. That
 * only works if the user's embedded wallet lists the key as a session signer —
 * which must be granted client-side, with the user's consent, at login (the
 * server cannot add a signer to a user-owned wallet). Without this, every live
 * money path 401s "no valid authorization keys". The id is a PUBLIC identifier
 * (not the private key, which lives only in the server env). Build override:
 * VITE_PRIVY_AUTHORIZATION_KEY_ID.
 */
const DELEGATE_SIGNER_ID = (
  import.meta.env.VITE_PRIVY_AUTHORIZATION_KEY_ID ?? 'f5vylu4kgvwwtoqir4janwng'
).trim();

/** How long the Privy embed gets to become ready before we call it blocked. */
const READY_TIMEOUT_MS = 6_000;

type MazePrivyBridge = { login: () => Promise<string> };

export interface PrivyIslandOptions {
  /** Called with a Privy access token after a successful login. */
  onAccessToken: (accessToken: string) => void | Promise<void>;
  /** Called when the user surfaces a Privy error (display in toast). */
  onError?: (message: string) => void;
}

function getMazePrivyLogin(): (() => Promise<string>) | null {
  const bridge = (window as unknown as { MazePrivy?: MazePrivyBridge }).MazePrivy;
  return typeof bridge?.login === 'function' ? bridge.login.bind(bridge) : null;
}

function errorMessage(e: unknown, fallback: string): string {
  return e instanceof Error ? e.message : fallback;
}

/** Match the app's persisted theme so the embed doesn't flash off-brand. */
function appTheme(): 'light' | 'dark' {
  try {
    const stored = localStorage.getItem('maze.theme');
    if (stored === 'dark' || stored === 'light') return stored;
  } catch {
    /* storage unavailable — fall through */
  }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

async function runBridgeLogin(opts: PrivyIslandOptions): Promise<void> {
  const login = getMazePrivyLogin();
  if (!login) throw new Error('Privy sign-in is not configured for this build.');
  const token = await login();
  if (!token) throw new Error('Privy access token unavailable.');
  await opts.onAccessToken(token);
}

interface LoginUiProps extends PrivyIslandOptions {
  /** Full island remount — retries the Privy embed after a blocked load. */
  onRetry: () => void;
}

/** Embedded (Privy-managed) wallet addresses from a user's linked accounts. */
function embeddedWalletAddresses(user: ReturnType<typeof usePrivy>['user']): string[] {
  const accounts = (user?.linkedAccounts ?? []) as unknown as Array<Record<string, unknown>>;
  return accounts
    .filter((a) => a['type'] === 'wallet' && a['walletClientType'] === 'privy' && typeof a['address'] === 'string')
    .map((a) => a['address'] as string);
}

function LoginUI(opts: LoginUiProps) {
  const { ready, authenticated, getAccessToken, user } = usePrivy();
  const { addSessionSigners } = useSessionSigners();
  const [pending, setPending] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [method, setMethod] = useState<'idle' | 'email' | 'code'>('idle');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [emailBusy, setEmailBusy] = useState(false);

  useEffect(() => {
    if (!authenticated || !pending) return;
    let cancelled = false;
    (async () => {
      try {
        const token = await getAccessToken();
        if (!cancelled && token) await opts.onAccessToken(token);
      } catch (e) {
        if (!cancelled) opts.onError?.(errorMessage(e, 'Privy access token unavailable.'));
      } finally {
        if (!cancelled) setPending(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authenticated, pending, getAccessToken, opts]);

  // Grant the server signer on every embedded wallet once logged in, so the
  // backend can sign trades/swaps/deposits for this user. Best-effort: a
  // failure (delegation not enabled, already granted) is logged, never blocks
  // the session. Runs once per authenticated user; adding an existing signer
  // is a harmless no-op / caught error.
  useEffect(() => {
    if (!authenticated || !DELEGATE_SIGNER_ID || !user) return;
    const addresses = embeddedWalletAddresses(user);
    if (!addresses.length) return;
    let cancelled = false;
    void (async () => {
      for (const address of addresses) {
        if (cancelled) return;
        try {
          await addSessionSigners({ address, signers: [{ signerId: DELEGATE_SIGNER_ID }] });
        } catch (e) {
          // Non-fatal: server signing simply stays unavailable for this wallet.
          console.warn('privy: session-signer delegation failed', errorMessage(e, 'delegate failed'));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authenticated, user, addSessionSigners]);

  // Watchdog: the embed iframe can be blocked (adblock / CSP / outage), in
  // which case `ready` never flips and every button below would stay disabled
  // forever with no explanation. Surface it.
  useEffect(() => {
    if (ready || getMazePrivyLogin()) return;
    const timer = window.setTimeout(() => setLoadFailed(true), READY_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [ready]);

  const { initOAuth } = useLoginWithOAuth({
    onError: (err) => {
      setPending(false);
      opts.onError?.(typeof err === 'string' ? err : 'Google sign-in failed.');
    },
  });

  const { sendCode, loginWithCode } = useLoginWithEmail({
    onError: (err) => {
      setEmailBusy(false);
      setPending(false);
      opts.onError?.(typeof err === 'string' ? err : 'Email sign-in failed.');
    },
  });

  const startGoogle = useCallback(() => {
    if (pending || authenticated) return;
    setPending(true);
    const bridgeLogin = getMazePrivyLogin();
    if (bridgeLogin) {
      void runBridgeLogin(opts)
        .catch((e: unknown) => opts.onError?.(errorMessage(e, 'Privy sign-in failed.')))
        .finally(() => setPending(false));
      return;
    }
    if (!ready) {
      setPending(false);
      return;
    }
    void initOAuth({ provider: 'google' }).catch((e: unknown) => {
      setPending(false);
      opts.onError?.(errorMessage(e, 'Google sign-in failed.'));
    });
  }, [authenticated, initOAuth, opts, pending, ready]);

  const submitEmail = useCallback(async () => {
    const address = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
      opts.onError?.('Enter a valid email address.');
      return;
    }
    setEmailBusy(true);
    try {
      await sendCode({ email: address });
      setMethod('code');
    } catch (e) {
      opts.onError?.(errorMessage(e, 'Could not send the code.'));
    } finally {
      setEmailBusy(false);
    }
  }, [email, opts, sendCode]);

  const submitCode = useCallback(async () => {
    const digits = code.trim();
    if (digits.length < 4) {
      opts.onError?.('Enter the code from your email.');
      return;
    }
    setEmailBusy(true);
    setPending(true);
    try {
      await loginWithCode({ code: digits });
      // The authenticated+pending effect above completes the token handoff.
    } catch (e) {
      setPending(false);
      opts.onError?.(errorMessage(e, 'Code verification failed.'));
    } finally {
      setEmailBusy(false);
    }
  }, [code, loginWithCode, opts]);

  if (loadFailed && !ready) {
    return (
      <div style={{ display: 'grid', gap: 10 }}>
        <p className="sub" style={{ textAlign: 'center', maxWidth: '32ch', marginInline: 'auto' }}>
          Sign-in couldn't load. A content blocker or network filter may be
          blocking auth.privy.io.
        </p>
        <button type="button" className="btn acc" onClick={opts.onRetry}>
          Retry sign-in
        </button>
      </div>
    );
  }

  const connecting = !ready && !getMazePrivyLogin();

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <button
        type="button"
        className="btn acc"
        disabled={connecting || pending || authenticated}
        onClick={startGoogle}
      >
        {connecting ? 'Connecting...' : pending ? 'Opening Google...' : 'Continue with Google'}
      </button>

      {method === 'idle' && (
        <button
          type="button"
          className="btn"
          disabled={connecting || pending}
          onClick={() => setMethod('email')}
        >
          Continue with email
        </button>
      )}

      {method === 'email' && (
        <div className="field" style={{ marginTop: 0, textAlign: 'left' }}>
          <label htmlFor="privyEmailInput">Email</label>
          <input
            id="privyEmailInput"
            className="inp"
            type="email"
            inputMode="email"
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submitEmail();
            }}
          />
          <button type="button" className="btn" disabled={emailBusy} onClick={() => void submitEmail()}>
            {emailBusy ? 'Sending code...' : 'Send code'}
          </button>
        </div>
      )}

      {method === 'code' && (
        <div className="field" style={{ marginTop: 0, textAlign: 'left' }}>
          <label htmlFor="privyCodeInput">Code sent to {email.trim()}</label>
          <input
            id="privyCodeInput"
            className="inp"
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="6-digit code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submitCode();
            }}
          />
          <button
            type="button"
            className="btn acc"
            disabled={emailBusy || pending}
            onClick={() => void submitCode()}
          >
            {emailBusy || pending ? 'Verifying...' : 'Verify code'}
          </button>
          <button
            type="button"
            className="pillbtn"
            disabled={emailBusy}
            onClick={() => void submitEmail()}
          >
            Resend code
          </button>
        </div>
      )}

      <p
        className="sub"
        style={{ textAlign: 'center', fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--meta)' }}
      >
        Self-custody wallet secured by Privy.
      </p>
    </div>
  );
}

let activeRoot: Root | null = null;
let lastMount: { container: HTMLElement; opts: PrivyIslandOptions } | null = null;

function mountBridgeButton(container: HTMLElement, opts: PrivyIslandOptions): void {
  if (activeRoot) {
    activeRoot.unmount();
    activeRoot = null;
  }
  container.textContent = '';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn acc';
  button.textContent = 'Continue with Google';
  button.addEventListener('click', () => {
    button.disabled = true;
    button.textContent = 'Opening Google...';
    void runBridgeLogin(opts)
      .catch((e: unknown) => opts.onError?.(errorMessage(e, 'Privy sign-in failed.')))
      .finally(() => {
        button.disabled = false;
        button.textContent = 'Continue with Google';
      });
  });
  container.appendChild(button);
  container.setAttribute('data-state', 'fallback');
}

export function mountPrivyIsland(container: HTMLElement, opts: PrivyIslandOptions): void {
  lastMount = { container, opts };
  // Only the app id is required by the React SDK; clientId is an optional
  // extra. Requiring both here is what silently shipped the dead e2e-bridge
  // button to production.
  if (!PRIVY_APP_ID) {
    mountBridgeButton(container, opts);
    return;
  }
  if (activeRoot) {
    activeRoot.unmount();
    activeRoot = null;
  }
  const onRetry = (): void => {
    if (!lastMount) return;
    mountPrivyIsland(lastMount.container, lastMount.opts);
  };
  activeRoot = createRoot(container);
  activeRoot.render(
    <StrictMode>
      <PrivyProvider
        appId={PRIVY_APP_ID}
        {...(PRIVY_CLIENT_ID ? { clientId: PRIVY_CLIENT_ID } : {})}
        config={{
          appearance: { theme: appTheme(), accentColor: '#FF6A1A' },
          loginMethods: ['google', 'email'],
        }}
      >
        <LoginUI {...opts} onRetry={onRetry} />
      </PrivyProvider>
    </StrictMode>,
  );
}

export function unmountPrivyIsland(): void {
  if (activeRoot) {
    activeRoot.unmount();
    activeRoot = null;
  }
}
