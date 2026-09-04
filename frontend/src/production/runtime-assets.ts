// @evidence src/app/dist/renderer/assets/index-UbX-y3il.js#L34
// Packaged output resolves assets relative to its own module URL. The source
// development server exposes checked-in/public assets at the same-origin root.
export function rendererRuntimeAssetUrl(file: string): string {
  const base = import.meta.env?.DEV === true
    ? new URL("/assets/", window.location.href)
    : new URL("./", import.meta.url);
  return new URL(file, base).href;
}
