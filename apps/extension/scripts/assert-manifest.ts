import { panic } from "better-result";

import { STELLA_CONTENT_SCRIPT_MATCHES } from "../src/lib/trusted-origin";

const manifestPath = new URL(
  "../.output/chrome-mv3/manifest.json",
  import.meta.url,
);
const manifest = await Bun.file(manifestPath).json();

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
if (manifest.host_permissions !== undefined) {
  panic("Extension must not declare mandatory host_permissions");
}

const forbiddenPermissions = [
  "cookies",
  "debugger",
  "declarativeNetRequestFeedback",
  "downloads",
  "tabs",
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
if (!exactSet(contentScripts.at(0)?.matches, STELLA_CONTENT_SCRIPT_MATCHES)) {
  panic("Extension content script escaped the configured stella origin list");
}
