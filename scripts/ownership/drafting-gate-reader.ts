import type { OwnershipEntry } from "../ownership-types.ts";

const TEST_REASON =
  "Drives the drafting endpoints and model calls with a stand-in gate read; production admits only by reading the database.";

export default {
  id: "drafting-gate-reader",
  capability: "Admitting desktop drafting through a stand-in gate read",
  owner: ["apps/api/src/handlers/desktop-time-entries/drafting-model.ts"],
  summary:
    "A drafting admission proves the organization's switch and the member's consent were read from the database. `admitDraftingWithGateReader` answers that read from a function instead, so only tests may call it.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/handlers/desktop-time-entries/drafting-model"],
    names: ["admitDraftingWithGateReader"],
    allowed: [
      {
        path: "apps/api/src/handlers/desktop-time-entries/billing-drafts.test.ts",
        reason: TEST_REASON,
      },
      {
        path: "apps/api/src/handlers/desktop-time-entries/narrative.test.ts",
        reason: TEST_REASON,
      },
      {
        path: "apps/api/src/handlers/desktop-time-entries/drafting-model.test.ts",
        reason: TEST_REASON,
      },
      {
        path: "apps/api/src/tests/helpers/ai-text-call-sites.ts",
        reason: TEST_REASON,
      },
    ],
  },
} as const satisfies OwnershipEntry;
