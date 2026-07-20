import { Result } from "better-result";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { buildBindingCatalog } from "@/api/lib/template-binding/binding-catalog";

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
  // The catalog is static (built from the binding-sources taxonomy), so there
  // is no failable IO; yielding the already-built catalog through `Result.ok`
  // keeps the generator form consistent with every other endpoint handler.
  async function* () {
    const catalog = yield* Result.ok(buildBindingCatalog());
    return Result.ok(catalog);
  },
);

export default getBindingCatalog;
