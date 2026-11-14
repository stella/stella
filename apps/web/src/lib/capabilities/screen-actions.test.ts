import { describe, expect, test } from "bun:test";

import { RESOURCE_TYPE, resourceRef, toResourceName } from "@stll/api-contract";

import { useScreenActionsStore } from "@/lib/capabilities/screen-actions";
import type { ScreenAction } from "@/lib/capabilities/screen-actions";
import { toSafeId } from "@/lib/safe-id";

const matter = toResourceName(
  resourceRef({
    type: RESOURCE_TYPE.WORKSPACE,
    id: toSafeId<"workspace">("018f6e4a-0000-7000-8000-000000000001"),
  }),
);

describe("screen actions", () => {
  test("each registration is released independently", () => {
    const { register } = useScreenActionsStore.getState();
    const action = {
      capability: "billing-codes.create",
      resource: matter,
    } satisfies ScreenAction;

    const releaseFirst = register(action);
    const releaseSecond = register(action);
    expect([...useScreenActionsStore.getState().actions.values()]).toEqual([
      action,
      action,
    ]);

    releaseFirst();
    expect([...useScreenActionsStore.getState().actions.values()]).toEqual([
      action,
    ]);

    releaseSecond();
    expect(useScreenActionsStore.getState().actions.size).toBe(0);
  });
});
