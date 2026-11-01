type LoadListener = (fn: () => void) => void;

interface ServiceWorkerLike {
  controller: unknown;
  register(
    scriptURL: string,
    options?: RegistrationOptions,
  ): Promise<Pick<ServiceWorkerRegistration, 'installing' | 'addEventListener'>>;
}

interface RegisterOptions {
  isProd: boolean;
  serviceWorker?: ServiceWorkerLike | undefined;
  addLoadListener?: LoadListener;
  onUpdateReady?: () => void;
}

export function registerMazeServiceWorker({
  isProd,
  serviceWorker,
  addLoadListener = (fn) => window.addEventListener('load', fn),
  onUpdateReady,
}: RegisterOptions): boolean {
  if (!isProd || !serviceWorker) return false;

  addLoadListener(() => {
    serviceWorker
      .register('/sw.js', { scope: '/' })
      .then((reg) => {
        reg.addEventListener('updatefound', () => {
          const sw = reg.installing;
          if (!sw) return;
          sw.addEventListener('statechange', () => {
            if (sw.state === 'installed' && serviceWorker.controller) {
              onUpdateReady?.();
            }
          });
        });
      })
      .catch(() => {
        /* Service worker registration is best-effort. */
      });
  });

  return true;
}
