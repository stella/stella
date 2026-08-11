import { panic } from "better-result";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  assertOfficeRuntimeEntryIsIsolated,
  assertOutlookReleaseVersion,
  createContentHashedAssetName,
  getOutlookDeploymentHeaderRules,
  normalizeOutlookReleaseOrigins,
  resolveOutlookFrameAncestors,
  versionAssetContent,
} from "./release-artifact";
import {
  type ManifestEnv,
  renderManifest,
  resolveManifestPlaceholders,
  resolveOutlookRuntimeConfig,
} from "./render-manifest";
import { validateManifestFile } from "./validate-manifest";

const APP_ROOT = path.resolve(import.meta.dirname, "..");
const DIST_DIR = path.resolve(APP_ROOT, "dist");
const DIST_ASSETS_DIR = path.resolve(DIST_DIR, "assets");
const UNHASHED_ASSETS_DIR = path.resolve(DIST_DIR, ".assets");
const PUBLIC_ASSETS_DIR = path.resolve(APP_ROOT, "public", "assets");
const PUBLIC_ROBOTS_PATH = path.resolve(APP_ROOT, "public", "robots.txt");
const COMMANDS_ENTRY_PATH = path.resolve(APP_ROOT, "src", "commands.ts");
const EVENT_RUNTIME_ENTRY_PATH = path.resolve(APP_ROOT, "src", "events.ts");

const parseEnv = (): ManifestEnv => {
  const flag = process.argv.find((arg) => arg.startsWith("--env="));
  const value = flag?.slice("--env=".length);
  if (value === "prod") {
    return "prod";
  }
  if (value && value !== "dev") {
    panic(`Unknown --env value: ${value}. Expected "dev" or "prod".`);
  }
  return "dev";
};

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

const writeContentHashedAsset = ({
  fileName,
  version,
}: {
  fileName: string;
  version: string;
}): string => {
  const sourcePath = path.resolve(UNHASHED_ASSETS_DIR, fileName);
  const extension = path.extname(fileName);
  const name = path.basename(fileName, extension);
  const content = versionAssetContent({
    content: readFileSync(sourcePath),
    extension,
    version,
  });
  const hashedFileName = createContentHashedAssetName({
    content,
    extension,
    name,
  });
  writeFileSync(path.resolve(DIST_ASSETS_DIR, hashedFileName), content);
  return `/assets/${hashedFileName}`;
};

const writeHtml = ({
  fileName,
  html,
}: {
  fileName: string;
  html: string;
}) => {
  writeFileSync(path.resolve(DIST_DIR, fileName), html);
};

const targetEnv = parseEnv();
const placeholders = resolveManifestPlaceholders(targetEnv);
assertOutlookReleaseVersion(placeholders.VERSION);
const runtimeConfig = resolveOutlookRuntimeConfig({
  env: targetEnv,
  placeholders,
});
const uploadOrigin = process.env["STELLA_UPLOAD_ORIGIN"];
const frameAncestors = resolveOutlookFrameAncestors(
  process.env["STELLA_OUTLOOK_FRAME_ANCESTORS"],
);

// Commands are an Office-only runtime. V1 deliberately has no event-based
// activation or Smart Alerts; any future event entry must pass this same guard.
assertOfficeRuntimeEntryIsIsolated(readFileSync(COMMANDS_ENTRY_PATH, "utf-8"));
if (existsSync(EVENT_RUNTIME_ENTRY_PATH)) {
  panic(
    "Event activation must use a separately reviewed Office-only build entry and manifest function file; it cannot join the React task pane.",
  );
}

rmSync(DIST_DIR, { force: true, recursive: true });
mkdirSync(DIST_ASSETS_DIR, { recursive: true });
mkdirSync(UNHASHED_ASSETS_DIR, { recursive: true });

const build = Bun.spawnSync(
  [
    "bun",
    "build",
    "./src/main.tsx",
    "./src/commands.ts",
    "./src/dialog.ts",
    "./src/office-history-after.ts",
    "./src/office-history-before.ts",
    "--outdir",
    "dist/.assets",
    "--target",
    "browser",
    "--format",
    "esm",
    "--entry-naming",
    "[name].[ext]",
    "--asset-naming",
    "[name].[ext]",
    "--define",
    `globalThis.STELLA_BUILD_ENV=${JSON.stringify(targetEnv)}`,
    "--define",
    `globalThis.STELLA_API_ORIGIN=${JSON.stringify(runtimeConfig.apiBaseUrl)}`,
    "--define",
    `globalThis.STELLA_OUTLOOK_VERSION=${JSON.stringify(placeholders.VERSION)}`,
    "--define",
    `globalThis.STELLA_TASKPANE_ORIGIN=${JSON.stringify(runtimeConfig.taskpaneOrigin)}`,
    "--define",
    `globalThis.STELLA_WEB_ORIGIN=${JSON.stringify(runtimeConfig.webOrigin)}`,
  ],
  { cwd: APP_ROOT },
);

if (!build.success) {
  panic(`Outlook build failed:\n${decode(build.stderr)}`);
}

const tailwindArgs = [
  "bun",
  "x",
  "@tailwindcss/cli",
  "--input",
  "./src/styles.css",
  "--output",
  "./dist/.assets/main.css",
];
if (targetEnv === "prod") {
  tailwindArgs.push("--minify");
}

const tailwind = Bun.spawnSync(tailwindArgs, { cwd: APP_ROOT });

if (!tailwind.success) {
  panic(`Outlook CSS build failed:\n${decode(tailwind.stderr)}`);
}

const assets = {
  commands: writeContentHashedAsset({
    fileName: "commands.js",
    version: placeholders.VERSION,
  }),
  dialog: writeContentHashedAsset({
    fileName: "dialog.js",
    version: placeholders.VERSION,
  }),
  historyAfter: writeContentHashedAsset({
    fileName: "office-history-after.js",
    version: placeholders.VERSION,
  }),
  historyBefore: writeContentHashedAsset({
    fileName: "office-history-before.js",
    version: placeholders.VERSION,
  }),
  main: writeContentHashedAsset({
    fileName: "main.js",
    version: placeholders.VERSION,
  }),
  styles: writeContentHashedAsset({
    fileName: "main.css",
    version: placeholders.VERSION,
  }),
};

rmSync(UNHASHED_ASSETS_DIR, { force: true, recursive: true });

for (const fileName of readdirSync(PUBLIC_ASSETS_DIR)) {
  if (!fileName.endsWith(".png")) {
    continue;
  }
  copyFileSync(
    path.resolve(PUBLIC_ASSETS_DIR, fileName),
    path.resolve(DIST_ASSETS_DIR, fileName),
  );
}
copyFileSync(PUBLIC_ROBOTS_PATH, path.resolve(DIST_DIR, "robots.txt"));

writeHtml({
  fileName: "taskpane.html",
  html: `<!doctype html>
<html lang="en" data-framework="typescript">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="X-UA-Compatible" content="IE=Edge" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex, nofollow" />
    <meta name="stella-outlook-version" content="${placeholders.VERSION}" />
    <title>stella for Outlook</title>
    <script type="text/javascript" src="${assets.historyBefore}"></script>
    <script type="text/javascript" src="https://appsforoffice.microsoft.com/lib/1.1/hosted/office.js"></script>
    <script type="text/javascript" src="${assets.historyAfter}"></script>
    <link rel="stylesheet" href="${assets.styles}" />
    <script type="module" src="${assets.main}"></script>
  </head>
  <body>
    <main id="root"></main>
  </body>
</html>
`,
});

writeHtml({
  fileName: "commands.html",
  html: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="X-UA-Compatible" content="IE=Edge" />
    <meta name="robots" content="noindex, nofollow" />
    <meta name="stella-outlook-version" content="${placeholders.VERSION}" />
    <script type="text/javascript" src="https://appsforoffice.microsoft.com/lib/1.1/hosted/office.js"></script>
    <script type="module" src="${assets.commands}"></script>
  </head>
  <body></body>
</html>
`,
});

writeHtml({
  fileName: "dialog.html",
  html: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="robots" content="noindex, nofollow" />
    <meta name="stella-outlook-version" content="${placeholders.VERSION}" />
    <title>stella sign in</title>
    <script type="module" src="${assets.dialog}"></script>
  </head>
  <body></body>
</html>
`,
});

const manifest = renderManifest(targetEnv);
writeFileSync(path.resolve(DIST_DIR, "manifest.xml"), manifest);
if (targetEnv === "dev") {
  writeFileSync(path.resolve(APP_ROOT, "manifest.xml"), manifest);
}

const releaseMetadata = {
  assets,
  origins: {
    apiOrigin: runtimeConfig.apiBaseUrl,
    ...(frameAncestors ? { frameAncestors } : {}),
    taskpaneOrigin: runtimeConfig.taskpaneOrigin,
    ...(uploadOrigin ? { uploadOrigin } : {}),
    webOrigin: runtimeConfig.webOrigin,
  },
  schemaVersion: 1,
  version: placeholders.VERSION,
};
writeFileSync(
  path.resolve(DIST_DIR, "release.json"),
  `${JSON.stringify(releaseMetadata, null, 2)}\n`,
);

if (targetEnv === "prod") {
  const origins = normalizeOutlookReleaseOrigins(releaseMetadata.origins);
  writeFileSync(
    path.resolve(DIST_DIR, "deployment-headers.json"),
    `${
      JSON.stringify(
        {
          rules: getOutlookDeploymentHeaderRules(origins),
          schemaVersion: 1,
          version: placeholders.VERSION,
        },
        null,
        2,
      )
    }\n`,
  );
}

// Validate the rendered manifest against Microsoft's official XSD set so a
// schema-invalid manifest fails the build instead of failing at sideload.
validateManifestFile(path.resolve(DIST_DIR, "manifest.xml"));

console.log(`Built Outlook add-in (${targetEnv}) to apps/outlook/dist`);
