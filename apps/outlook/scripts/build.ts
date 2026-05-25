import { panic } from "better-result";
import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

const APP_ROOT = resolve(import.meta.dirname, "..");
const DIST_DIR = resolve(APP_ROOT, "dist");
const DIST_ASSETS_DIR = resolve(DIST_DIR, "assets");
const PUBLIC_ASSETS_DIR = resolve(APP_ROOT, "public", "assets");

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

rmSync(DIST_DIR, { force: true, recursive: true });
mkdirSync(DIST_ASSETS_DIR, { recursive: true });

const build = Bun.spawnSync(
  [
    "bun",
    "build",
    "./src/main.tsx",
    "./src/commands.ts",
    "--outdir",
    "dist/assets",
    "--target",
    "browser",
    "--format",
    "esm",
    "--entry-naming",
    "[name].[ext]",
    "--asset-naming",
    "[name].[ext]",
  ],
  {
    cwd: APP_ROOT,
  },
);

if (!build.success) {
  panic(`Outlook build failed:\n${decode(build.stderr)}`);
}

for (const fileName of readdirSync(PUBLIC_ASSETS_DIR)) {
  if (!fileName.endsWith(".svg")) {
    continue;
  }
  copyFileSync(
    resolve(PUBLIC_ASSETS_DIR, fileName),
    resolve(DIST_ASSETS_DIR, fileName),
  );
}

writeFileSync(
  resolve(DIST_DIR, "taskpane.html"),
  `<!doctype html>
<html lang="en" data-framework="typescript">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="X-UA-Compatible" content="IE=Edge" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Stella Outlook</title>
    <script type="text/javascript">
      window.__STELLA_HISTORY__ = {
        replaceState: window.history.replaceState,
        pushState: window.history.pushState,
      };
    </script>
    <script
      type="text/javascript"
      src="https://appsforoffice.microsoft.com/lib/1.1/hosted/office.js"
    ></script>
    <script type="text/javascript">
      window.history.replaceState = window.__STELLA_HISTORY__.replaceState;
      window.history.pushState = window.__STELLA_HISTORY__.pushState;
    </script>
    <link rel="stylesheet" href="/assets/main.css" />
    <script type="module" src="/assets/main.js"></script>
  </head>
  <body>
    <main id="root"></main>
  </body>
</html>
`,
);

writeFileSync(
  resolve(DIST_DIR, "commands.html"),
  `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="X-UA-Compatible" content="IE=Edge" />
    <script
      type="text/javascript"
      src="https://appsforoffice.microsoft.com/lib/1.1/hosted/office.js"
    ></script>
    <script type="module" src="/assets/commands.js"></script>
  </head>
  <body></body>
</html>
`,
);

console.log("Built Outlook add-in to apps/outlook/dist");
