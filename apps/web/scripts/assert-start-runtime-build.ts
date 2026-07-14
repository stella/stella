import { fileURLToPath } from "node:url";

const WEB_ROOT_URL = new URL("../", import.meta.url);
const WEB_ROOT_PATH = fileURLToPath(WEB_ROOT_URL);

const requiredFiles = [
  "dist/server/server.js",
  "dist/client/dark-mode-init.js",
] as const;

const requiredFileExistence = await Promise.all(
  requiredFiles.map(
    async (path) => await Bun.file(new URL(path, WEB_ROOT_URL)).exists(),
  ),
);
const missingPaths: string[] = requiredFiles.filter(
  (_, index) => !requiredFileExistence[index],
);

const clientAssetGlob = new Bun.Glob("dist/client/assets/*");
const firstClientAsset = await clientAssetGlob
  .scan({ cwd: WEB_ROOT_PATH })
  .next();
const hasClientAsset = !firstClientAsset.done;

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
