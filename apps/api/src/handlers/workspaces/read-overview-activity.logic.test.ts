import { describe, expect, test } from "bun:test";

import { parseFieldAuditResourceId } from "./read-overview-activity.logic";

const fieldId = "00000000-0000-0000-0000-000000000001";
const entityVersionId = "00000000-0000-0000-0000-000000000002";
const propertyId = "00000000-0000-0000-0000-000000000003";

describe("parseFieldAuditResourceId", () => {
  test("keeps persisted field ids on the field lookup path", () => {
    expect(parseFieldAuditResourceId(fieldId)).toEqual({
      fieldId,
      type: "field",
    });
  });

  test("extracts the entity version from composite cell audit ids", () => {
    expect(
      parseFieldAuditResourceId(`${entityVersionId}:${propertyId}`),
    ).toEqual({ entityVersionId, type: "cell" });
  });

  test("rejects malformed persisted values before UUID queries", () => {
    expect(
      parseFieldAuditResourceId(`${entityVersionId}:not-a-uuid`),
    ).toBeNull();
    expect(parseFieldAuditResourceId("not-a-field-id")).toBeNull();
  });
});
