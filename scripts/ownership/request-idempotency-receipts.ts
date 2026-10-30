import { readdirSync, readFileSync } from "node:fs";
import ts from "typescript6";

import { compareCodeUnit } from "@stll/collation";

import type { OwnershipEntry } from "../ownership-types.ts";

// Deriving the published scope from declarations prevents documentation drift.
const handlersDirectory = new URL(
  "../../apps/api/src/handlers/",
  import.meta.url,
);
const replayHandlers = () =>
  readdirSync(handlersDirectory, {
    recursive: true,
    encoding: "utf-8",
  })
    .filter((file) => file.endsWith("/create.ts"))
    .filter((file) => {
      const source = ts.createSourceFile(
        file,
        readFileSync(new URL(file, handlersDirectory), "utf-8"),
        ts.ScriptTarget.Latest,
        true,
      );
      const declaresReplay = (node: ts.Node): boolean => {
        if (
          ts.isPropertyAssignment(node) &&
          ts.isIdentifier(node.name) &&
          node.name.text === "idempotency" &&
          ts.isObjectLiteralExpression(node.initializer)
        ) {
          return node.initializer.properties.some(
            (entry) =>
              ts.isPropertyAssignment(entry) &&
              ts.isIdentifier(entry.name) &&
              entry.name.text === "type" &&
              ts.isStringLiteral(entry.initializer) &&
              entry.initializer.text === "replay",
          );
        }
        return ts.forEachChild(node, declaresReplay) ?? false;
      };
      return declaresReplay(source);
    })
    .toSorted(compareCodeUnit)
    .map((file) => `\`apps/api/src/handlers/${file}\``)
    .join(", ");

export default {
  id: "request-idempotency-receipts",
  capability: "Claiming, replaying and retaining create request receipts",
  owner: ["apps/api/src/lib/idempotency/request-receipts.ts"],
  summary: () =>
    `One owner claims create intents, replays completed JSON responses, commits creates with their replay responses in one transaction, releases rolled-back intents and sweeps expired unlocked receipts. Pending rows become eligible after two minutes; the hourly bounded sweep skips active transaction locks. Callers use its scoped operations; the receipt table stays private to this owner except for its focused lifecycle declaration, membership cleanup and shared aggregate lock acquisition. Organization removal deletes the departing member's receipts in the removal transaction; active receipt owners cause a retryable conflict instead of a lock-order inversion. Removing one matter membership retains bounded organization-level coordination so other matters cannot duplicate committed creates. Account deletion cascades to every user receipt. Generic replay is limited to these DB-only creates (derived from their replay declarations): ${replayHandlers()}. Durable uploads, native-dedup flows, background handoffs and the detached feedback store retain their existing lifecycle; only flows with existing native deduplication retain that guarantee. Scoped safe handlers without replay declarations reject Idempotency-Key rather than accepting it silently.`,
  enforcement: {
    kind: "import",
    specifiers: ["@/api/db/schema", "@/api/db/schema/request-idempotency"],
    names: ["requestIdempotencyReceipts"],
    allowed: [
      {
        path: "apps/api/src/db/entity-feature-gate-repair.ts",
        reason:
          "Schema metadata enumeration only; no receipt rows read or written.",
      },
      {
        path: "apps/api/src/lib/idempotency/request-receipt-transition-spec.ts",
        reason:
          "Declares the receipt lifecycle graph for the transition owner.",
      },
      {
        path: "apps/api/src/lib/member-assignment-offboarding.ts",
        reason:
          "Deletes the departing organization member's receipts in the membership-removal transaction and declares the cleanup disposition.",
      },
      {
        path: "apps/api/src/lib/db/aggregate-lock.ts",
        reason:
          "Owns the principal-scoped NOWAIT receipt lock set and records each held receipt in the shared aggregate lock history.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
