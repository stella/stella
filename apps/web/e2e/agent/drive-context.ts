import type { Page } from "@playwright/test";

import type { RenderActionMeasurement } from "../helpers/render-probe";

export type DriveScriptContext = {
  apiUrl: string;
  page: Page;
  // Bound to this flow's page; each result is also collected in the report.
  measureAction: (
    label: string,
    action: () => Promise<unknown>,
  ) => Promise<RenderActionMeasurement>;
  snap: (label: string, options?: { waitFor?: string }) => Promise<void>;
  webUrl: string;
};
