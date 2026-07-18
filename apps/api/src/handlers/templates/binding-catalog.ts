import { Result } from "better-result";

import { buildBindingCatalog } from "@/api/handlers/docx/binding-catalog";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";

const config = {
  permissions: { workspace: ["read"] },
  mcp: { type: "capability", reason: "template_authoring_ui" },
} satisfies HandlerConfig;

/**
 * Return the data-binding catalog: the `(source, field)` options a template
 * author can bind a field to, each with an i18n label key. Static today (built
 * from the binding-sources taxonomy), so no IO; the catalog is identical for
 * every workspace in the org.
 */
const getBindingCatalog = createSafeRootHandler(
  config,
  // The catalog is static (built from the binding-sources taxonomy), so this
  // safe handler has no failable IO to await; the generator form is kept for
  // endpoint-handler consistency.
  // eslint-disable-next-line require-yield -- static catalog, nothing to await
  async function* () {
    return Result.ok(buildBindingCatalog());
  },
);

export default getBindingCatalog;
