import { panic } from "better-result";

import { rawStellaOrigins } from "../src/lib/env";
import {
  createStellaOriginTrust,
  parseTrustedOriginList,
  STAGING_STELLA_ORIGINS,
} from "../src/lib/trusted-origin";

// `production` checks the release build; `staging` checks the build for the
// hosted staging app; `e2e` checks the Playwright build, the only one besides
// development allowed to trust loopback stella origins.
const BUILD_OUTPUT_DIRECTORIES = {
  e2e: "chrome-mv3-e2e",
  production: "chrome-mv3",
  staging: "chrome-mv3-staging",
} as const;

// Written out rather than imported, so a change to the shared default list
// cannot move the release build's trust and its check together.
const RELEASE_CONTENT_SCRIPT_MATCHES = [
  "https://app.stll.app/*",
  "https://my.stll.app/*",
];

const buildTarget = process.argv.at(2) ?? "production";
if (
  buildTarget !== "production" &&
  buildTarget !== "staging" &&
  buildTarget !== "e2e"
) {
  panic(`Unknown extension build target: ${buildTarget}`);
}
const expectedReleaseVersion = process.argv.at(3);
const manifestPath =
  process.argv.at(4) ??
  new URL(
    `../.output/${BUILD_OUTPUT_DIRECTORIES[buildTarget]}/manifest.json`,
    import.meta.url,
  );
const manifest = await Bun.file(manifestPath).json();
const expectedTrust = createStellaOriginTrust({
  hostedOrigins: parseTrustedOriginList(rawStellaOrigins, buildTarget),
  trustLoopback: buildTarget === "e2e",
});

const exactSet = (value: unknown, expected: readonly string[]): boolean =>
  Array.isArray(value) &&
  value.length === expected.length &&
  expected.every((entry) => value.includes(entry));

if (expectedReleaseVersion !== undefined) {
  if (
    buildTarget !== "production" ||
    !/^\d+\.\d+\.\d+$/u.test(expectedReleaseVersion)
  ) {
    panic("Store releases require a stable production version");
  }
  if (manifest.version !== expectedReleaseVersion) {
    panic("Extension manifest version must equal the release version");
  }
}

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

// A release or staging build grants nothing on loopback or plain HTTP, in
// any key.
const serialized = JSON.stringify(manifest);
if (buildTarget !== "e2e") {
  for (const forbidden of ["http://", "localhost", "127.0.0.1", "[::1]"]) {
    if (serialized.includes(forbidden)) {
      panic(`${buildTarget} extension manifest must not mention ${forbidden}`);
    }
  }
}

// The release build never trusts staging, even through WXT_STELLA_ORIGINS,
// and without that override it trusts exactly the production origins.
if (buildTarget === "production") {
  for (const origin of STAGING_STELLA_ORIGINS) {
    if (serialized.includes(new URL(origin).hostname)) {
      panic(`Production extension manifest must not mention ${origin}`);
    }
  }
  if (
    (expectedReleaseVersion !== undefined ||
      (rawStellaOrigins ?? "").trim() === "") &&
    !exactSet(contentScripts.at(0)?.matches, RELEASE_CONTENT_SCRIPT_MATCHES)
  ) {
    panic("Production extension must trust exactly the production origins");
  }
}
