import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import { createChatRefRegistry } from "@/api/lib/chat/ref-registry";

import { resolveRegistryToolOutputRefs } from "./output-ref-resolution";

describe("registry tool output ref resolution", () => {
  test("resolves declared paths without rewriting opaque sibling fields", () => {
    const registry = createChatRefRegistry();
    const workspaceId = toSafeId<"workspace">("workspace-opaque");
    const matterRef = registry.toMatterRef(workspaceId);
    const output = {
      decisionId: matterRef,
      matters: [
        {
          decisionId: matterRef,
          id: matterRef,
          nested: { cursor: matterRef },
        },
      ],
    };

    expect(
      resolveRegistryToolOutputRefs({
        output,
        refRegistry: registry,
        toolName: "list_matters",
      }),
    ).toEqual({
      decisionId: matterRef,
      matters: [
        {
          decisionId: matterRef,
          id: workspaceId,
          nested: { cursor: matterRef },
        },
      ],
    });
  });

  test("leaves unknown tool outputs untouched", () => {
    const registry = createChatRefRegistry();
    const output = {
      id: registry.toMatterRef(toSafeId<"workspace">("workspace-opaque")),
    };

    expect(
      resolveRegistryToolOutputRefs({
        output,
        refRegistry: registry,
        toolName: "third-party-tool",
      }),
    ).toBe(output);
  });
});
