import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

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
      id: "opaque/id with spaces:and?symbols)!",
    });
    expect(resource).not.toBeNull();
    if (resource === null) {
      return;
    }

    const name = toResourceName(resource);
    expect(String(name)).toBe(
      `${RESOURCE_NAME_PREFIX}entity/id=opaque%2Fid%20with%20spaces%3Aand%3Fsymbols%29%21`,
    );
    expect(parseResourceName(name)).toEqual(resource);
  });

  test("protects dot-segment IDs from URL normalization", () => {
    for (const id of [".", ".."]) {
      const resource = parseResourceRef({ type: RESOURCE_TYPE.ENTITY, id });
      expect(resource).not.toBeNull();
      if (resource === null) {
        continue;
      }

      const normalizedName = new URL(toResourceName(resource)).href;
      expect(parseResourceName(normalizedName)).toEqual(resource);
    }
  });

  test("URL-normalized names round-trip arbitrary opaque IDs", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 64, unit: "binary" }),
        (id) => {
          const resource = parseResourceRef({
            type: RESOURCE_TYPE.ENTITY,
            id,
          });
          expect(resource).not.toBeNull();
          if (resource === null) {
            return;
          }

          const normalizedName = new URL(toResourceName(resource)).href;
          expect(parseResourceName(normalizedName)).toEqual(resource);
        },
      ),
      propertyConfig({ numRuns: 200 }),
    );
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
      parseResourceRef({ type: RESOURCE_TYPE.ENTITY, id: "\uD800" }),
    ).toBeNull();
    expect(() => toSafeId<"entity">("")).toThrow(
      "Expected a non-empty, well-formed identifier",
    );
    expect(() => toSafeId<"entity">("\uD800")).toThrow(
      "Expected a non-empty, well-formed identifier",
    );
    expect(
      parseResourceRef({
        type: RESOURCE_TYPE.ENTITY,
        id: "entity-1",
        title: "Domain payload",
      }),
    ).toBeNull();

    expect(parseResourceName("https://example.com/entity/id")).toBeNull();
    expect(
      parseResourceName(`${RESOURCE_NAME_PREFIX}unknown/id=value`),
    ).toBeNull();
    expect(parseResourceName(`${RESOURCE_NAME_PREFIX}entity/`)).toBeNull();
    expect(
      parseResourceName(`${RESOURCE_NAME_PREFIX}entity/id=value/extra`),
    ).toBeNull();
    expect(
      parseResourceName(`${RESOURCE_NAME_PREFIX}entity/id=%69d`),
    ).toBeNull();
    expect(
      parseResourceName(`${RESOURCE_NAME_PREFIX}entity/id=%E0%A4%A`),
    ).toBeNull();
    expect(parseResourceName(`${RESOURCE_NAME_PREFIX}entity/id`)).toBeNull();
  });
});
