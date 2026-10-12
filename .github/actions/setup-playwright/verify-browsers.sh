#!/usr/bin/env bash
set -euo pipefail
cd "${GITHUB_WORKSPACE:?}/${PLAYWRIGHT_PACKAGE_DIR:-apps/web}"
if [[ ! -d node_modules/@playwright/test ]]; then
  echo "::error::Playwright is not installed in $PWD" >&2
  exit 1
fi
playwright_package=$(realpath node_modules/@playwright/test)
echo "Container Playwright package: $playwright_package"
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
