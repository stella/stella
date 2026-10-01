#!/usr/bin/env bash
set -euo pipefail
cd "${GITHUB_WORKSPACE:?}/apps/web"
bun -e '
  import { existsSync } from "node:fs";
  import * as playwright from "@playwright/test";
  for (const name of (process.env["BROWSERS"] ?? "chromium").split(" ").filter(Boolean)) {
    if (!["chromium", "firefox", "webkit"].includes(name)) throw new Error(`Unknown browser: ${name}`);
    const executable = playwright[name].executablePath();
    if (!executable.startsWith("/ms-playwright/") || !existsSync(executable)) {
      throw new Error(`Pinned image is missing ${name}: ${executable}`);
    }
    console.log(`${name} uses image executable ${executable}`);
    const browser = await playwright[name].launch();
    await browser.close();
  }
'
