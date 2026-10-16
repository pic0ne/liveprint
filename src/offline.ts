let registered = false;

/** Registers the service worker once, in production. Called after the first pages show, so its downloads never slow the first load. */
export function registerServiceWorker(): void {
  if (registered || !import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  registered = true;
  navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch((error: unknown) => console.warn('Offline support is off:', error));
}
