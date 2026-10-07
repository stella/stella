import { panic } from "better-result";
import { readFileSync } from "node:fs";
import { defineConfig } from "wxt";

const releaseVersion = readFileSync(
  new URL("../../VERSION", import.meta.url),
  "utf-8",
).trim();
if (!/^\d+\.\d+\.\d+(?:-(?:rc|beta|alpha)\.\d+)?$/u.test(releaseVersion)) {
  panic("Extension version must come from a valid product release VERSION");
}
// Chrome accepts only numeric versions; prerelease builds retain their label.
const chromeVersion = releaseVersion.replace(/-.*$/u, "");

export default defineConfig({
  imports: false,
  manifest: {
    version: chromeVersion,
    version_name: releaseVersion,
    icons: {
      16: "icon/16.png",
      32: "icon/32.png",
      48: "icon/48.png",
      128: "icon/128.png",
    },
    action: {
      default_popup: "popup.html",
      default_title: "__MSG_extensionName__",
    },
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'self'",
    },
    default_locale: "en",
    description: "__MSG_extensionDescription__",
    // Response-header conditions for the download block need Chrome 128.
    minimum_chrome_version: "128",
    name: "__MSG_extensionName__",
    optional_host_permissions: ["https://*/*"],
    // Granted with website access in one prompt: cancelling downloads a
    // controlled page starts from script, and tracing which page opened a
    // new tab or which frame started a download.
    optional_permissions: ["downloads", "webNavigation"],
    permissions: ["activeTab", "declarativeNetRequest", "scripting", "storage"],
  },
  srcDir: "src",
  zip: { artifactTemplate: "stella-extension-chrome-{{version}}.zip" },
});
