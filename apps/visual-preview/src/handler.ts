import chromium from "@sparticuz/chromium-min";
import { Result } from "better-result";
import { chromium as playwright } from "playwright-core";
import * as v from "valibot";

import { visualPreviewInputSchema } from "@stll/api-contract/visual-preview";

import { renderVisual, VisualRenderError } from "./render";

export const handler = async (event: unknown) => {
  const parsed = v.safeParse(visualPreviewInputSchema, event);
  if (!parsed.success) {
    throw new VisualRenderError({ message: "Invalid preview input" });
  }
  const rendered = await renderVisual({
    input: parsed.output,
    launch: async () =>
      playwright.launch({
        executablePath: await chromium.executablePath("/opt/chromium"),
        args: [
          ...chromium.args.filter(
            (arg) =>
              ![
                "--disable-web-security",
                "--allow-running-insecure-content",
                "--disable-site-isolation-trials",
              ].includes(arg),
          ),
          "--host-resolver-rules=MAP * ~NOTFOUND",
          "--disable-background-networking",
        ],
        headless: true,
        timeout: 5000,
        chromiumSandbox: false,
      }),
  });
  if (Result.isError(rendered)) {
    throw rendered.error;
  }
  return rendered.value;
};
