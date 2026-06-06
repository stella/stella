const WEB_ROOT_URL = new URL("../", import.meta.url);

const requiredFiles = [
  "dist/server/server.js",
  "dist/client/dark-mode-init.js",
] as const;

const missingPaths: string[] = [];
for (const path of requiredFiles) {
  if (await Bun.file(new URL(path, WEB_ROOT_URL)).exists()) {
    continue;
  }

  missingPaths.push(path);
}

const clientAssetGlob = new Bun.Glob("dist/client/assets/*");
let hasClientAsset = false;
for await (const clientAssetPath of clientAssetGlob.scan({
  cwd: WEB_ROOT_URL.pathname,
})) {
  hasClientAsset = clientAssetPath.length > 0;
  break;
}

if (!hasClientAsset) {
  missingPaths.push("dist/client/assets/*");
}

if (missingPaths.length > 0) {
  console.error(
    [
      "TanStack Start runtime build contract failed.",
      "The deploy pipeline expects a server bundle plus client assets.",
      ...missingPaths.map((path) => `Missing: apps/web/${path}`),
    ].join("\n"),
  );
  process.exit(1);
}
