import { describe, expect, test } from "bun:test";

import { resourceRef, RESOURCE_TYPE, toSafeId } from "@stll/api-contract";

import { parseStellaMentionHref } from "@/components/chat/chat-mention-href";

describe("chat mention hrefs", () => {
  test("recognizes stable entity hrefs used by clickable document mentions", () => {
    const workspaceId = toSafeId<"workspace">(
      "0dc54d0c-10d7-501d-897e-e801dbd0998c",
    );
    const entityId = toSafeId<"entity">(
      "c09ec856-d945-5ecc-82e3-bb5382165f34",
    );
    expect(
      parseStellaMentionHref(
        `#stella-entity=${workspaceId}:${entityId}`,
      ),
    ).toEqual({
      category: "entity",
      id: `${workspaceId}:${entityId}`,
      target: {
        type: RESOURCE_TYPE.ENTITY,
        resource: resourceRef({ type: RESOURCE_TYPE.ENTITY, id: entityId }),
        location: {
          type: "workspace",
          workspace: resourceRef({
            type: RESOURCE_TYPE.WORKSPACE,
            id: workspaceId,
          }),
        },
      },
    });
  });

  test("does not treat request-local entity refs as stable mention hrefs", () => {
    expect(parseStellaMentionHref("#stella-entity-ref=ent_1")).toBeNull();
  });
});
