import { panic } from "better-result";

import type { EntityKind } from "@stll/api-contract";

import type { properties } from "@/api/db/schema";
import type { PropertyTool } from "@/api/db/schema-validators";

/**
 * Which entity kinds a property's tool can ever hold a value for; `null`
 * means every kind (`properties.kinds` in
 * `apps/api/src/db/schema/properties.ts`).
 *
 * AI extraction only ever runs over documents: see the
 * `eq(entities.kind, "document")` filter in
 * `apps/api/src/lib/document-review/table-run-create.ts`. An `ai-model`
 * property is populated by that extraction, and a `playbook-verdict`
 * property grades an `ai-model` ASK property's extracted value, so neither
 * can ever hold a value on a task, message, link, or folder. A
 * `manual-input` value has no such constraint: a person can set it by hand
 * on any entity kind.
 */
export const propertyKindsForTool = (
  tool: Pick<PropertyTool, "type">,
): EntityKind[] | null => {
  switch (tool.type) {
    case "ai-model":
    case "playbook-verdict":
      return ["document"];
    case "manual-input":
      return null;
    default:
      tool.type satisfies never;
      return panic(`Unhandled type: ${String(tool.type)}`);
  }
};

type PropertyKindsForUpdateParams = {
  /** The stored row before the update: its tool and its stored scope. */
  previous: Pick<typeof properties.$inferSelect, "kinds" | "tool">;
  /** The tool the update writes. */
  next: Pick<PropertyTool, "type">;
};

/**
 * The scope an update writes. A manual-input property keeps whatever scope
 * it already stores: only server code ever narrows a manual property (the
 * workspace's system file property is created with `["document"]`), and a
 * rename must not widen it to every kind. Any change of tool type re-derives
 * the scope from the new tool.
 */
export const propertyKindsForUpdate = ({
  previous,
  next,
}: PropertyKindsForUpdateParams): EntityKind[] | null =>
  next.type === "manual-input" && previous.tool.type === "manual-input"
    ? previous.kinds
    : propertyKindsForTool(next);
