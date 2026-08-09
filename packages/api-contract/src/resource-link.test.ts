import { describe, expect, test } from "bun:test";

import { parseChatResourceHref, toChatResourceHref } from "./resource-link";
import { resourceRef, RESOURCE_TYPE } from "./resource-ref";
import { toSafeId } from "./safe-id";

describe("chat resource links", () => {
  test("round-trips an entity without merging its workspace into identity", () => {
    const target = {
      type: RESOURCE_TYPE.ENTITY,
      resource: resourceRef({
        type: RESOURCE_TYPE.ENTITY,
        id: toSafeId<"entity">("entity-1"),
      }),
      location: {
        type: "workspace",
        workspace: resourceRef({
          type: RESOURCE_TYPE.WORKSPACE,
          id: toSafeId<"workspace">("workspace-1"),
        }),
      },
    } as const;

    expect(parseChatResourceHref(toChatResourceHref(target))).toEqual(target);
  });

  test("round-trips resources that need no route context", () => {
    const targets = [
      {
        type: RESOURCE_TYPE.WORKSPACE,
        resource: resourceRef({
          type: RESOURCE_TYPE.WORKSPACE,
          id: toSafeId<"workspace">("workspace-1"),
        }),
      },
      {
        type: RESOURCE_TYPE.CASE_LAW_DECISION,
        resource: resourceRef({
          type: RESOURCE_TYPE.CASE_LAW_DECISION,
          id: toSafeId<"caseLawDecision">("decision-1"),
        }),
      },
    ] as const;

    for (const target of targets) {
      expect(parseChatResourceHref(toChatResourceHref(target))).toEqual(target);
    }
  });

  test("marks legacy relative entity links as render-context dependent", () => {
    expect(parseChatResourceHref("#stella-entity=entity-1")).toEqual({
      type: RESOURCE_TYPE.ENTITY,
      resource: resourceRef({
        type: RESOURCE_TYPE.ENTITY,
        id: toSafeId<"entity">("entity-1"),
      }),
      location: { type: "render_context" },
    });
  });

  test("rejects malformed and unrelated links", () => {
    expect(parseChatResourceHref("#stella-entity=:")).toBeNull();
    expect(parseChatResourceHref("#stella-workspace=")).toBeNull();
    expect(parseChatResourceHref("#stella-decision=")).toBeNull();
    expect(parseChatResourceHref("https://example.com/resource/1")).toBeNull();
  });
});
