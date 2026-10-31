const BUN_UNIX_VIRTUAL_ROOT = "/$bunfs/";
const BUN_WINDOWS_VIRTUAL_ROOT = "/B:/~BUN/";

// Bun flattens module URLs in a compiled executable; explicitly embedded
// assets retain their paths relative to the CLI package instead.
export const runtimeAssetUrl = (source: URL, embeddedPath: string): URL => {
  const moduleUrl = new URL(import.meta.url);
  const embedded =
    moduleUrl.protocol === "file:" &&
    (moduleUrl.pathname.startsWith(BUN_UNIX_VIRTUAL_ROOT) ||
      moduleUrl.pathname.startsWith(BUN_WINDOWS_VIRTUAL_ROOT));
  return embedded ? new URL(embeddedPath, moduleUrl) : source;
};
