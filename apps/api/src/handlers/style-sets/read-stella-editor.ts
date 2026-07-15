import { Result } from "better-result";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { createStellaStyleEditorPreset } from "@/api/lib/style-set-editor";

const config = {
  permissions: { styleSet: ["use"] },
  mcp: { type: "capability", reason: "template_authoring_ui" },
} satisfies HandlerConfig;

export default createSafeRootHandler(
  config,
  // eslint-disable-next-line require-yield, sonarjs/generator-without-yield -- safe handlers use Result generators.
  async function* () {
    const editor = createStellaStyleEditorPreset();
    return Result.ok({ settings: editor.settings });
  },
);
