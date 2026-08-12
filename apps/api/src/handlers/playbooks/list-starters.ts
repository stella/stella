import { Result } from "better-result";

import { STARTER_PLAYBOOKS } from "@/api/handlers/playbooks/starters";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";

const config = {
  description:
    "List the bundled starter playbooks available to instantiate: each " +
    "starter's id, name, description, target document type, and how many " +
    "positions it holds. Metadata only, enough to render a picker; create " +
    "one with playbooks.from-starter.",
  permissions: { workspace: ["read"] },
  mcp: { type: "capability", reason: "knowledge_library_admin" },
  access: "read",
} satisfies HandlerConfig;

// Minimal metadata only (no positions/tiers): the gallery just needs enough
// to render a card and let the user pick one to instantiate.
const listStarterPlaybooks = createSafeRootHandler(
  config,
  // eslint-disable-next-line require-yield, typescript/require-await -- safe handlers must remain async generators for Result.gen error capture.
  async function* () {
    return Result.ok({
      items: STARTER_PLAYBOOKS.map((starter) => ({
        starterId: starter.starterId,
        name: starter.name,
        description: starter.description,
        documentTypeKey: starter.documentTypeKey,
        positionCount: starter.positions.items.length,
      })),
    });
  },
);

export default listStarterPlaybooks;
