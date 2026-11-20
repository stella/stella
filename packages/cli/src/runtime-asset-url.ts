const BUN_UNIX_VIRTUAL_ROOT = "file:///$bunfs/";
const BUN_WINDOWS_VIRTUAL_ROOT = "file:///B:/~BUN/";

// Bun flattens module URLs in a compiled executable; explicitly embedded
// assets retain their paths relative to the CLI package instead.
export const runtimeAssetUrl = (source: URL, embeddedPath: string): URL => {
  const moduleUrl = new URL(import.meta.url);
  const embedded =
    moduleUrl.href.startsWith(BUN_UNIX_VIRTUAL_ROOT) ||
    moduleUrl.href.startsWith(BUN_WINDOWS_VIRTUAL_ROOT);
  return embedded ? new URL(embeddedPath, moduleUrl) : source;
};
