import { expect, test } from "bun:test";

import { excludedSourceField } from "@/api/lib/legal-search/ingestion-types";
import { encodeSourceRawEnvelope } from "@/api/lib/legal-search/source-raw-envelope";
import { isRecord } from "@/api/lib/type-guards";

import { auditRetainedPublisherFields } from "./link-recall-field-audit";

const fields = {
  id: { disposition: "stored", target: { type: "identity" } },
  alias: excludedSourceField({
    reason: "duplicate_of",
    justification: "Repeated source identifier",
    pointer: "id",
  }),
} as const;
const inventory = {
  status: "declared",
  fields,
  listSourceFields: (parts: Readonly<Record<string, string>>) => {
    const value: unknown = JSON.parse(parts["record"] ?? "null");
    return isRecord(value) ? Object.keys(value) : [];
  },
} as const;
test("retained publisher field audit exposes exclusions and newly added fields without source writes", async () => {
  const sourceRaw = encodeSourceRawEnvelope({
    record: JSON.stringify({ id: "1", alias: "1", added: "kept raw" }),
  });
  const report = await auditRetainedPublisherFields({ inventory, sourceRaw });
  expect(report).toMatchObject({
    status: "audited",
    observedFields: ["id", "alias", "added"],
    observedFieldCount: 3,
    unmappedFields: ["added"],
    excludedFields: [
      {
        field: "alias",
        reason: "duplicate_of",
        justification: "Repeated source identifier",
        pointer: "id",
      },
    ],
  });
  const removed = await auditRetainedPublisherFields({
    inventory: { ...inventory, fields: { alias: fields.alias } },
    sourceRaw,
  });
  expect(removed).toMatchObject({
    status: "audited",
    unmappedFields: ["id", "added"],
  });
});
test("missing and legacy raw are unavailable measurements", async () => {
  expect(
    await auditRetainedPublisherFields({ inventory, sourceRaw: null }),
  ).toEqual({ status: "unavailable", reason: "missing-raw" });
  expect(
    await auditRetainedPublisherFields({
      inventory,
      sourceRaw: "<html>legacy capture</html>",
    }),
  ).toEqual({ status: "unavailable", reason: "legacy-raw" });
});

test("a modern envelope without any observed publisher fields is unavailable", async () => {
  expect(
    await auditRetainedPublisherFields({
      inventory,
      sourceRaw: encodeSourceRawEnvelope({ record: "{}" }),
    }),
  ).toEqual({ status: "unavailable", reason: "no-observed-fields" });
});
