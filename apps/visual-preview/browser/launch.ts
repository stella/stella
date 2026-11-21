import { chromium } from "playwright-core";

import type { VisualPreviewLaunchOptions } from "../src/render";

export const launchPreviewBrowser = async ({
  args,
}: VisualPreviewLaunchOptions) => chromium.launch({ headless: true, args });
