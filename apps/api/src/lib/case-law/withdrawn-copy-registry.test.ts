import { expect, test } from "bun:test";
import { pgTable, text, uuid } from "drizzle-orm/pg-core";

import { jsonb } from "@/api/db/columns";
import { caseLawDecisions } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

import type { DecisionCopyTableNames } from "./withdrawn-copy-registry";
import { unregisteredDecisionCopyStores } from "./withdrawn-copy-registry";

test("every decision-associated tenant table is classified", () => {
  expect(unregisteredDecisionCopyStores()).toEqual([]);
});

test("a new decision-associated store requires a projection", () => {
  const newCopy = pgTable("decision_notes", {
    organizationId: text("organization_id").notNull(),
    decisionId: uuid("decision_id").notNull(),
    quote: text("quote").notNull(),
  });
  expect(unregisteredDecisionCopyStores({ newCopy })).toEqual(["newCopy"]);
});

const jsonCopy = pgTable("decision_snapshots", {
  organizationId: text("organization_id").notNull(),
  snapshot: jsonb("snapshot").$type<{
    items: { decisionId: SafeId<"caseLawDecision">; quote: string }[];
  }>(),
});
"jsonCopy" satisfies DecisionCopyTableNames<{ jsonCopy: typeof jsonCopy }>;

test("decision foreign keys and target discriminators also require classification", () => {
  const foreignCopy = pgTable("linked_quotes", {
    organizationId: text("organization_id").notNull(),
    source: uuid("source").references(() => caseLawDecisions.id),
    quote: text("quote"),
  });
  const targetCopy = pgTable("target_quotes", {
    organizationId: text("organization_id").notNull(),
    targetType: text("target_type", { enum: ["decision", "statute"] }),
    targetId: uuid("target_id"),
    quote: text("quote"),
  });
  expect(unregisteredDecisionCopyStores({ foreignCopy, targetCopy })).toEqual([
    "foreignCopy",
    "targetCopy",
  ]);
});

const deepJsonCopy = pgTable("deep_decision_snapshots", {
  organizationId: text("organization_id"),
  snapshot: jsonb("snapshot").$type<{
    a: { b: { c: { d: { e: { decisionId: string } } } } };
  }>(),
});
"deepJsonCopy" satisfies DecisionCopyTableNames<{
  deepJsonCopy: typeof deepJsonCopy;
}>;

const numericJson = pgTable("numbered_content", {
  organizationId: text("organization_id"),
  content: jsonb("content").$type<Record<number, string>>(),
});
true satisfies [
  DecisionCopyTableNames<{ numericJson: typeof numericJson }>,
] extends [never]
  ? true
  : never;
