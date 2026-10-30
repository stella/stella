import { panic, Result } from "better-result";

import { expandSchemaDefs } from "../expand-schema-defs.js";
import { flagKey } from "../flag-name.js";
import type {
  CapabilityFlagSpec,
  CapabilityLeafSpec,
  RouteNode,
} from "../route-types.js";
import { flagValueProvided } from "../run-leaf-command.js";
import type { BatchCommand, BatchItem, BatchResponse } from "./runner.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isUnknownArray = (value: unknown): value is unknown[] =>
  Array.isArray(value);

/** Lookups use the active tree, so deployment and scope omissions stay effective. */
export const findCapability = (
  tree: RouteNode,
  capabilityId: string,
): CapabilityLeafSpec | undefined => {
  switch (tree.kind) {
    case "leaf":
      return undefined;
    case "capability-leaf":
      return tree.spec.capabilityId === capabilityId ? tree.spec : undefined;
    case "route":
      for (const child of Object.values(tree.children)) {
        const match = findCapability(child, capabilityId);
        if (match !== undefined) {
          return match;
        }
      }
      return undefined;
    default:
      tree satisfies never;
      return panic("Unknown CLI route kind");
  }
};

/** Read the endpoint-owned ceiling rather than duplicating it in a CLI map. */
export const collectionMaximum = (
  spec: CapabilityLeafSpec,
  property: string,
): number => {
  const schema = expandSchemaDefs(spec.inputSchema);
  if (schema === null) {
    return panic("Bulk capability schema cannot be expanded");
  }
  const properties = schema["properties"];
  const body = isRecord(properties) ? properties["body"] : undefined;
  const bodyProperties = isRecord(body) ? body["properties"] : undefined;
  const collection = isRecord(bodyProperties)
    ? bodyProperties[property]
    : undefined;
  const maximum = isRecord(collection) ? collection["maxItems"] : undefined;
  if (
    typeof maximum !== "number" ||
    !Number.isSafeInteger(maximum) ||
    maximum < 1
  ) {
    return panic(
      `Bulk capability ${spec.capabilityId} has no bounded ${property} collection`,
    );
  }
  return maximum;
};

/** Each chunk retains the caller's matter and action; only its ID list changes. */
export const chunkCapabilityIds = (
  spec: CapabilityLeafSpec,
  input: Record<string, unknown>,
): Record<string, unknown>[] => {
  if (
    !spec.capabilityId.includes(".batch.") &&
    !spec.capabilityId.includes(".bulk.") &&
    !spec.capabilityId.startsWith("time-entries.approval-queue.") &&
    !spec.capabilityId.endsWith(".delete")
  ) {
    return [input];
  }
  const body = input["body"];
  if (!isRecord(body)) {
    return [input];
  }
  const collection = Object.entries(body).find(
    ([key, value]) => /(?:^ids$|Ids$)/u.test(key) && Array.isArray(value),
  );
  if (collection === undefined) {
    return [input];
  }
  const [property, value] = collection;
  if (!Array.isArray(value)) {
    return panic("ID collection lost its array shape");
  }
  const maximum = collectionMaximum(spec, property);
  const chunks: Record<string, unknown>[] = [];
  for (let offset = 0; offset < value.length; offset += maximum) {
    chunks.push({
      ...input,
      body: { ...body, [property]: value.slice(offset, offset + maximum) },
    });
  }
  return chunks.length === 0 ? [input] : chunks;
};

/** A single collection has an unambiguous --ids alias, regardless of its domain name. */
export const bulkIdsFlag = (
  spec: CapabilityLeafSpec,
): CapabilityFlagSpec | undefined => {
  if (
    !spec.capabilityId.includes(".batch.") &&
    !spec.capabilityId.includes(".bulk.") &&
    !spec.capabilityId.endsWith(".delete")
  ) {
    return undefined;
  }
  const candidates = spec.flags.filter(
    (flag) =>
      flag.part === "body" &&
      flag.kind === "string-array" &&
      /(?:^ids$|Ids$)/u.test(flag.partPath),
  );
  return candidates.length === 1 ? candidates.at(0) : undefined;
};

export const resolveBulkIdFlags = (
  spec: CapabilityLeafSpec,
  flags: Record<string, unknown>,
): Result<Record<string, unknown>, string> => {
  const alias = bulkIdsFlag(spec);
  if (
    alias === undefined ||
    flagKey(alias) === "ids" ||
    !flagValueProvided(alias, flags["ids"])
  ) {
    return Result.ok(flags);
  }
  const canonicalKey = flagKey(alias);
  if (flagValueProvided(alias, flags[canonicalKey])) {
    return Result.err(`Use either --ids or ${alias.flag}, not both.`);
  }
  return Result.ok({ ...flags, [canonicalKey]: flags["ids"] });
};

/** A future contact bulk capability is discoverable only after its catalog ships. */
export const contactBulkDeleteCapability = (
  tree: RouteNode,
): CapabilityLeafSpec | undefined =>
  findCapability(tree, "contacts.bulk.delete");

type CreateCapabilityBulkHookOptions = {
  spec: CapabilityLeafSpec;
  tree: RouteNode;
  invoke: (
    spec: CapabilityLeafSpec,
    input: Record<string, unknown>,
    items: readonly BatchItem[],
  ) => Promise<BatchResponse>;
};

/** Only semantically equivalent single/bulk pairs may share this path. */
export const createCapabilityBulkHook = ({
  spec,
  tree,
  invoke,
}: CreateCapabilityBulkHookOptions): BatchCommand["bulk"] => {
  let bulkId: string | undefined;
  if (spec.capabilityId === "properties.create") {
    bulkId = "properties.batch.create";
  } else if (spec.capabilityId === "case-law.matter-links.create") {
    bulkId = "case-law.matter-links.batch.create";
  }
  if (bulkId === undefined) {
    return undefined;
  }
  const bulk = findCapability(tree, bulkId);
  if (bulk?.idempotency?.type !== "replay") {
    return undefined;
  }
  const contextOf = ({ body: _body, ...context }: Record<string, unknown>) =>
    JSON.stringify(context);
  return {
    maxItems: collectionMaximum(bulk, "items"),
    canGroup: (previous, next) =>
      contextOf(previous.input) === contextOf(next.input),
    execute: async (items) => {
      const first = items.at(0);
      if (first === undefined) {
        return panic("Cannot invoke an empty bulk group");
      }
      const response = await invoke(
        bulk,
        {
          ...first.input,
          body: { items: items.map((item) => item.input["body"]) },
        },
        items,
      );
      if (response.status !== "ok") {
        return items.map(() => response);
      }
      const payload = response.result;
      if (!isRecord(payload)) {
        return items.map(() => ({
          status: "unknown",
          reason:
            "Bulk endpoint returned an invalid result; reconcile the original request before retrying",
        }));
      }
      if (bulk.capabilityId === "properties.batch.create") {
        const ids = payload["ids"];
        if (
          !isUnknownArray(ids) ||
          ids.length !== items.length ||
          !ids.every((id) => typeof id === "string")
        ) {
          return items.map(() => ({
            status: "unknown",
            reason:
              "Bulk property result did not identify every item; reconcile the original request before retrying",
          }));
        }
        return ids.map((id) => ({ status: "ok", result: { id } }));
      }
      const linked = payload["linked"];
      const existing = payload["existing"];
      const rejected = payload["rejected"];
      if (
        !isUnknownArray(linked) ||
        !isUnknownArray(existing) ||
        !isUnknownArray(rejected)
      ) {
        return items.map(() => ({
          status: "unknown",
          reason:
            "Bulk matter-link result is incomplete; reconcile the original request before retrying",
        }));
      }
      return items.map((item) => {
        const body = item.input["body"];
        const decisionId = isRecord(body) ? body["decisionId"] : undefined;
        const result = [...linked, ...existing].find(
          (entry) => isRecord(entry) && entry["decisionId"] === decisionId,
        );
        if (result !== undefined) {
          return { status: "ok", result };
        }
        const rejection = rejected.find(
          (entry) => isRecord(entry) && entry["decisionId"] === decisionId,
        );
        return rejection === undefined
          ? {
              status: "unknown",
              reason:
                "Bulk matter-link result omitted this decision; reconcile the original request before retrying",
            }
          : { status: "error", error: rejection };
      });
    },
  };
};
