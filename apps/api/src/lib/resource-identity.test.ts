import { describe, expect, test } from "bun:test";

import { RESOURCE_ID_TYPE, RESOURCE_TYPE } from "@stll/api-contract";

import { RESOURCE_IDENTITY_DISPOSITION } from "@/api/lib/resource-identity";

describe("resource identity census", () => {
  test("covers every portable resource with a backend identifier decision", () => {
    const backendResourceTypes = new Set<string>(
      Object.values(RESOURCE_IDENTITY_DISPOSITION).flatMap((disposition) =>
        disposition.type === "non_resource" ? [] : [disposition.resourceType],
      ),
    );

    expect(backendResourceTypes).toEqual(
      new Set(Object.keys(RESOURCE_ID_TYPE)),
    );
  });

  test("binds each canonical resource to its exact storage ID brand", () => {
    for (const [idType, disposition] of Object.entries(
      RESOURCE_IDENTITY_DISPOSITION,
    )) {
      if (disposition.type !== "resource") {
        continue;
      }
      expect(RESOURCE_ID_TYPE[disposition.resourceType]).toBe(idType);
    }
  });

  test("presentation aliases resolve to one underlying identity", () => {
    expect(RESOURCE_IDENTITY_DISPOSITION.document).toEqual({
      type: "alias",
      resourceType: RESOURCE_TYPE.ENTITY,
    });
    expect(RESOURCE_IDENTITY_DISPOSITION.folder).toEqual({
      type: "alias",
      resourceType: RESOURCE_TYPE.ENTITY,
    });
    expect(RESOURCE_IDENTITY_DISPOSITION.task).toEqual({
      type: "alias",
      resourceType: RESOURCE_TYPE.ENTITY,
    });
    expect(RESOURCE_IDENTITY_DISPOSITION.matter).toEqual({
      type: "alias",
      resourceType: RESOURCE_TYPE.WORKSPACE,
    });
  });
});
