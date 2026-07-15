import { Result } from "better-result";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { createStellaStyleEditorPreset } from "@/api/lib/style-set-editor";

const config = {
  permissions: { styleSet: ["use"] },
  mcp: { type: "capability", reason: "template_authoring_ui" },
} satisfies HandlerConfig;

export default createSafeRootHandler(config, async function* () {
  const editor = yield* Result.ok(createStellaStyleEditorPreset());
  return Result.ok({ settings: editor.settings });
});
