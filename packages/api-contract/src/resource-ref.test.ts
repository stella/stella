import { describe, expect, test } from "bun:test";

import {
  isResourceType,
  parseResourceName,
  parseResourceRef,
  resourceRef,
  RESOURCE_ID_TYPE,
  RESOURCE_NAME_PREFIX,
  RESOURCE_TYPE,
  toResourceName,
} from "./resource-ref";
import { toSafeId } from "./safe-id";

describe("canonical resource identity", () => {
  test("the runtime type registry and public constants declare the same set", () => {
    const registryTypes = Object.keys(RESOURCE_ID_TYPE).filter(isResourceType);
    expect(new Set(registryTypes)).toEqual(
      new Set(Object.values(RESOURCE_TYPE)),
    );
  });

  test("every resource type round-trips through its durable name", () => {
    for (const type of Object.keys(RESOURCE_ID_TYPE).filter(isResourceType)) {
      const resource = parseResourceRef({ type, id: `${type}-id` });
      expect(resource).not.toBeNull();
      if (resource === null) {
        continue;
      }
      expect(parseResourceName(toResourceName(resource))).toEqual(resource);
    }
  });

  test("opaque identifier characters survive canonical serialization", () => {
    const resource = parseResourceRef({
      type: RESOURCE_TYPE.ENTITY,
      id: "opaque/id with spaces:and?symbols",
    });
    expect(resource).not.toBeNull();
    if (resource === null) {
      return;
    }

    const name = toResourceName(resource);
    expect(String(name)).toBe(
      `${RESOURCE_NAME_PREFIX}entity/opaque%2Fid%20with%20spaces%3Aand%3Fsymbols`,
    );
    expect(parseResourceName(name)).toEqual(resource);
  });

  test("the constructor strips domain payload from identity", () => {
    const input = {
      type: RESOURCE_TYPE.ENTITY,
      id: toSafeId<"entity">("entity-1"),
      title: "Domain payload",
    };

    expect(resourceRef(input)).toEqual({
      type: RESOURCE_TYPE.ENTITY,
      id: input.id,
    });
  });

  test("invalid references and non-canonical names fail closed", () => {
    expect(parseResourceRef(null)).toBeNull();
    expect(parseResourceRef({ type: "unknown", id: "id" })).toBeNull();
    expect(parseResourceRef({ type: RESOURCE_TYPE.ENTITY, id: "" })).toBeNull();
    expect(
      parseResourceRef({
        type: RESOURCE_TYPE.ENTITY,
        id: "entity-1",
        title: "Domain payload",
      }),
    ).toBeNull();

    expect(parseResourceName("https://example.com/entity/id")).toBeNull();
    expect(parseResourceName(`${RESOURCE_NAME_PREFIX}unknown/id`)).toBeNull();
    expect(parseResourceName(`${RESOURCE_NAME_PREFIX}entity/`)).toBeNull();
    expect(
      parseResourceName(`${RESOURCE_NAME_PREFIX}entity/id/extra`),
    ).toBeNull();
    expect(parseResourceName(`${RESOURCE_NAME_PREFIX}entity/%69d`)).toBeNull();
    expect(
      parseResourceName(`${RESOURCE_NAME_PREFIX}entity/%E0%A4%A`),
    ).toBeNull();
  });
});
