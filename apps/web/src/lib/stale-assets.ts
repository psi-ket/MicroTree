/**
 * True when an error means the browser could not load one of the app's own
 * code files (a lazily loaded module or worker). That happens when the page
 * was loaded from a different build than the server now serves, e.g. a tab
 * opened against `vite preview` that is still open after switching to
 * `pnpm dev`, or after a rebuild. Reloading the page fixes it.
 */
export function isStaleAssetError(message: string): boolean {
  return /dynamically imported module|importing a module script failed|fake worker|Failed to load module script/i.test(
    message,
  );
}

export const STALE_ASSET_MESSAGE =
  "This page is out of date: the web server now serves a different version of Research Studio's code. Reload the page to continue.";
