/**
 * Tests for the instance-token guard on `useActiveDocxStore`.
 *
 * The guard exists to survive a fast remount overlap (StrictMode
 * double-invoke or route-transition during which two
 * DocxBrowserEditor instances briefly coexist for the same
 * entityId): instance B mounts and overwrites A's slot, then A's
 * cleanup runs. Without the guard, A's blind delete leaves the
 * registry empty even though B is alive.
 */

import { createRef } from "react";

import { beforeEach, describe, expect, test } from "bun:test";

import type { DocxEditorRef } from "@stll/folio";

import { useActiveDocxStore } from "@/components/ai-suggestions/active-docx-store";

const makeRegistration = () => ({
  editorRef: createRef<DocxEditorRef | null>(),
  requestEditMode: () => true,
  editable: false,
});

describe("active-docx-store instance-token guard", () => {
  beforeEach(() => {
    // Reset between tests; the store is module-level singleton.
    useActiveDocxStore.setState({ byEntityId: {} });
  });

  test("registerEditor returns a unique token per call", () => {
    const a = useActiveDocxStore
      .getState()
      .registerEditor("ent_1", makeRegistration());
    const b = useActiveDocxStore
      .getState()
      .registerEditor("ent_2", makeRegistration());
    expect(typeof a).toBe("symbol");
    expect(typeof b).toBe("symbol");
    expect(a).not.toBe(b);
  });

  test("a stale unregister from a replaced instance is a no-op", () => {
    // Instance A mounts.
    const tokenA = useActiveDocxStore
      .getState()
      .registerEditor("ent_1", makeRegistration());

    // Instance B mounts for the same entity, overwriting A's slot.
    const registrationB = makeRegistration();
    const tokenB = useActiveDocxStore
      .getState()
      .registerEditor("ent_1", registrationB);
    expect(tokenA).not.toBe(tokenB);

    // Instance A's cleanup runs late — must NOT delete B's slot.
    useActiveDocxStore.getState().unregisterEditor("ent_1", tokenA);

    const slot = useActiveDocxStore.getState().byEntityId["ent_1"];
    expect(slot).toBeDefined();
    expect(slot?.token).toBe(tokenB);
    expect(slot?.registration).toBe(registrationB);
  });

  test("the live owner can unregister itself cleanly", () => {
    const token = useActiveDocxStore
      .getState()
      .registerEditor("ent_1", makeRegistration());
    useActiveDocxStore.getState().unregisterEditor("ent_1", token);
    expect(useActiveDocxStore.getState().byEntityId["ent_1"]).toBeUndefined();
  });

  test("updateEditable is scoped to the matching token", () => {
    const tokenA = useActiveDocxStore
      .getState()
      .registerEditor("ent_1", makeRegistration());

    // Owner toggles editable — applied.
    useActiveDocxStore.getState().updateEditable("ent_1", true, tokenA);
    expect(
      useActiveDocxStore.getState().byEntityId["ent_1"]?.registration.editable,
    ).toBe(true);

    // Replace with instance B.
    useActiveDocxStore.getState().registerEditor("ent_1", makeRegistration());
    // Stale write from A — must be ignored.
    useActiveDocxStore.getState().updateEditable("ent_1", false, tokenA);
    expect(
      useActiveDocxStore.getState().byEntityId["ent_1"]?.registration.editable,
    ).toBe(false); // B's initial registration value, not A's stale write
  });
});
