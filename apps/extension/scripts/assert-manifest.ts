import { panic } from "better-result";

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
if (!exactSet(manifest.permissions, ["activeTab", "scripting", "storage"])) {
  panic("Extension required permissions drifted");
}
if (
  !exactSet(manifest.optional_host_permissions, ["http://*/*", "https://*/*"])
) {
  panic("Extension optional host permissions drifted");
}
if (manifest.host_permissions !== undefined) {
  panic("Extension must not declare mandatory host_permissions");
}

const forbiddenPermissions = ["cookies", "debugger", "tabs", "webRequest"];
for (const permission of forbiddenPermissions) {
  if (manifest.permissions.includes(permission)) {
    panic(`Extension must not request ${permission}`);
  }
}

const contentScripts = manifest.content_scripts;
if (!Array.isArray(contentScripts) || contentScripts.length !== 1) {
  panic("Extension must contain exactly one stella bridge content script");
}
const matches = contentScripts.at(0)?.matches;
if (
  !exactSet(matches, [
    "http://127.0.0.1/*",
    "http://localhost/*",
    "https://app.stll.app/*",
    "https://my.stll.app/*",
    "https://staging.stll.app/*",
  ])
) {
  panic("Extension content script escaped the stella origin allowlist");
}
