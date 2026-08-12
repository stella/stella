import { Result } from "better-result";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { createStellaStyleEditorPreset } from "@/api/lib/style-set-editor";

const config = {
  description:
    "Read the built-in stella style preset as editor settings, the starting " +
    "point for a new style set. Takes no arguments and reads no stored data.",
  permissions: { styleSet: ["use"] },
  access: "read",
  mcp: { type: "capability", reason: "template_authoring_ui" },
} satisfies HandlerConfig;

// eslint-disable-next-line typescript/require-await -- safe handlers must remain async generators for Result.gen error capture.
export default createSafeRootHandler(config, async function* () {
  const editor = yield* Result.ok(createStellaStyleEditorPreset());
  return Result.ok({ settings: editor.settings });
});
