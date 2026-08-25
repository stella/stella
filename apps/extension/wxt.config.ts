import { defineConfig } from "wxt";

export default defineConfig({
  imports: false,
  manifest: {
    action: {
      default_popup: "popup.html",
      default_title: "__MSG_extensionName__",
    },
    default_locale: "en",
    description: "__MSG_extensionDescription__",
    name: "__MSG_extensionName__",
    optional_host_permissions: ["http://*/*", "https://*/*"],
    permissions: ["activeTab", "scripting", "storage"],
  },
  srcDir: "src",
});
