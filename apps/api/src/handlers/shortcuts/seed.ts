import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import { promptShortcuts } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { createSafeId } from "@/api/lib/branded-types";

const DEFAULT_SHORTCUTS = [
  {
    name: "Summarise a document",
    description: "Get a structured summary of the key terms",
    command: "summarize",
    prompt:
      "Summarise this document. Cover parties, key obligations, dates, financial terms, and any termination or liability provisions.",
  },
  {
    name: "Find risks",
    description: "Spot legal risks and ambiguous clauses",
    command: "risks",
    prompt:
      "Review this document for legal risks, missing protections, and ambiguous clauses. Cite the specific clause for each finding.",
  },
  {
    name: "Compare versions",
    description: "List every material change between two versions",
    command: "compare",
    prompt:
      "Compare two versions of this document and list every material change with its location.",
  },
  {
    name: "Draft a response",
    description: "Draft a professional reply to a letter",
    command: "draft",
    prompt:
      "Draft a measured response to this letter. Keep the tone professional, address each point raised, and flag any open questions for me to confirm.",
  },
] as const;

const config = {
  permissions: { promptShortcut: ["create"] },
} satisfies HandlerConfig;

const seedShortcuts = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, user }) {
    const existing = yield* Result.await(
      safeDb((tx) =>
        tx.$count(
          promptShortcuts,
          and(
            eq(promptShortcuts.organizationId, session.activeOrganizationId),
            eq(promptShortcuts.userId, user.id),
          ),
        ),
      ),
    );

    if (existing > 0) {
      return Result.ok({ seeded: false });
    }

    yield* Result.await(
      safeDb((tx) =>
        tx.insert(promptShortcuts).values(
          DEFAULT_SHORTCUTS.map((s) => ({
            id: createSafeId<"promptShortcut">(),
            organizationId: session.activeOrganizationId,
            userId: user.id,
            scope: "private" as const,
            name: s.name,
            description: s.description,
            command: s.command,
            prompt: s.prompt,
            isDefault: true,
          })),
        ),
      ),
    );

    return Result.ok({ seeded: true });
  },
);

export default seedShortcuts;
