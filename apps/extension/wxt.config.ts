import { defineConfig } from "wxt";

export default defineConfig({
  imports: false,
  manifest: {
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
    permissions: ["activeTab", "declarativeNetRequest", "scripting", "storage"],
  },
  srcDir: "src",
});
