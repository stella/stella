import { panic } from "better-result";

import { rawStellaOrigins } from "../src/lib/env";
import {
  createStellaOriginTrust,
  parseTrustedOriginList,
} from "../src/lib/trusted-origin";

// `production` checks the release build; `e2e` checks the Playwright build,
// the only other one allowed to trust loopback stella origins.
const BUILD_OUTPUT_DIRECTORIES = {
  e2e: "chrome-mv3-e2e",
  production: "chrome-mv3",
} as const;

const buildTarget = process.argv.at(2) ?? "production";
if (buildTarget !== "production" && buildTarget !== "e2e") {
  panic(`Unknown extension build target: ${buildTarget}`);
}
const manifestPath = new URL(
  `../.output/${BUILD_OUTPUT_DIRECTORIES[buildTarget]}/manifest.json`,
  import.meta.url,
);
const manifest = await Bun.file(manifestPath).json();
const expectedTrust = createStellaOriginTrust({
  hostedOrigins: parseTrustedOriginList(rawStellaOrigins),
  trustLoopback: buildTarget === "e2e",
});

const exactSet = (value: unknown, expected: readonly string[]): boolean =>
  Array.isArray(value) &&
  value.length === expected.length &&
  expected.every((entry) => value.includes(entry));

if (manifest.manifest_version !== 3) {
  panic("Extension build must produce Manifest V3");
}
if (manifest.minimum_chrome_version !== "128") {
  panic("Extension must require Chrome 128 for response-header rules");
}
if (
  manifest.content_security_policy?.extension_pages !==
  "script-src 'self'; object-src 'self'"
) {
  panic("Extension must declare the strict extension-pages CSP");
}
if (
  !exactSet(manifest.permissions, [
    "activeTab",
    "declarativeNetRequest",
    "scripting",
    "storage",
  ])
) {
  panic("Extension required permissions drifted");
}
if (!exactSet(manifest.optional_host_permissions, ["https://*/*"])) {
  panic("Extension optional host permissions drifted");
}
// Requested with website access: cancelling downloads a controlled page
// starts from `blob:` or `data:` URLs, and tracing which page opened a new
// tab or which frame started a download.
if (!exactSet(manifest.optional_permissions, ["downloads", "webNavigation"])) {
  panic("Extension optional permissions drifted");
}
if (manifest.host_permissions !== undefined) {
  panic("Extension must not declare mandatory host_permissions");
}

const forbiddenPermissions = [
  "cookies",
  "debugger",
  "declarativeNetRequestFeedback",
  "downloads",
  "tabs",
  "webNavigation",
  "webRequest",
  "webRequestBlocking",
];
for (const permission of forbiddenPermissions) {
  if (manifest.permissions.includes(permission)) {
    panic(`Extension must not request ${permission}`);
  }
}

const contentScripts = manifest.content_scripts;
if (!Array.isArray(contentScripts) || contentScripts.length !== 1) {
  panic("Extension must contain exactly one stella bridge content script");
}
if (
  !exactSet(contentScripts.at(0)?.matches, expectedTrust.contentScriptMatches)
) {
  panic("Extension content script escaped the configured stella origin list");
}

// A release build grants nothing on loopback or plain HTTP, in any key.
if (buildTarget === "production") {
  const serialized = JSON.stringify(manifest);
  for (const forbidden of ["http://", "localhost", "127.0.0.1", "[::1]"]) {
    if (serialized.includes(forbidden)) {
      panic(`Production extension manifest must not mention ${forbidden}`);
    }
  }
}
