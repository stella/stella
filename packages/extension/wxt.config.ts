import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "wxt";

export default defineConfig({
  srcDir: "src",
  modules: ["@wxt-dev/module-react"],
  dev: {
    server: {
      port: 3004,
    },
  },
  vite: () => ({
    plugins: [tailwindcss()],
  }),
  manifest: {
    name: "stella",
    description:
      "Save anything from the web to a matter in stella",
    permissions: [
      "sidePanel",
      "tabs",
      "scripting",
      "activeTab",
      "storage",
      "alarms",
    ],
    host_permissions: [
      "http://localhost:3000/*",
      "http://localhost:3001/*",
    ],
    externally_connectable: {
      matches: ["http://localhost:3000/*"],
    },
    icons: {
      16: "icon-16.png",
      48: "icon-48.png",
      128: "icon-128.png",
    },
  },
});
