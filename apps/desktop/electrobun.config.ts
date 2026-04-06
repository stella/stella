import type { ElectrobunConfig } from "electrobun";

const releaseBaseUrl = process.env["STELLA_DESKTOP_RELEASE_BASE_URL"];

export default {
  app: {
    name: "stella desktop",
    identifier: "legal.stella.desktop",
    version: "0.0.1",
  },
  runtime: {
    exitOnLastWindowClosed: false,
  },
  ...(releaseBaseUrl
    ? {
        release: {
          baseUrl: releaseBaseUrl,
        },
      }
    : {}),
  build: {
    copy: {
      "dist/index.html": "views/mainview/index.html",
      "dist/assets": "views/mainview/assets",
      "assets/icon-16.png": "views/assets/icon-16.png",
      "assets/icon-48.png": "views/assets/icon-48.png",
      "assets/tray-icon-32-template.png":
        "views/assets/tray-icon-32-template.png",
      "assets/tray-icon-64-template.png":
        "views/assets/tray-icon-64-template.png",
    },
    watchIgnore: ["dist/**"],
    linux: {
      bundleCEF: false,
    },
    mac: {
      bundleCEF: false,
      icons: "icon.iconset",
    },
    win: {
      bundleCEF: false,
    },
  },
} satisfies ElectrobunConfig;
