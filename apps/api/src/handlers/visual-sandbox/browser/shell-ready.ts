import * as v from "valibot";

import {
  VISUAL_SHELL_NONCE_PARAMETER,
  visualShellReadySchema,
} from "@stll/api-contract/visual-sandbox";

export const visualShellReadyMessage = (fragment: string) => {
  const nonce = new URLSearchParams(fragment.replace(/^#/u, "")).get(
    VISUAL_SHELL_NONCE_PARAMETER,
  );
  const parsed = v.safeParse(visualShellReadySchema, {
    kind: "shell-ready",
    nonce,
  });
  return parsed.success ? parsed.output : null;
};
