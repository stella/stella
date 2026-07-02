/**
 * Tests for the instance-token guard and per-(entity, file field)
 * keying on `useActiveDocxStore`.
 *
 * The guard exists to survive a fast remount overlap (StrictMode
 * double-invoke or route-transition during which two
 * DocxBrowserEditor instances briefly coexist for the same
 * (entity, file field)): instance B mounts and overwrites A's slot,
 * then A's cleanup runs. Without the guard, A's blind delete leaves
 * the registry empty even though B is alive.
 *
 * The composite key exists because one entity can hold multiple
 * DOCX file fields, each open in its own kept-mounted inspector
 * tab: keying by entity alone would let the last-mounted editor
 * overwrite the others' slots.
 */

import { createRef } from "react";

import { beforeEach, describe, expect, test } from "bun:test";

import type { DocxEditorRef } from "@stll/folio";

import {
  activeDocxKey,
  useActiveDocxStore,
} from "@/components/ai-suggestions/active-docx-store";

const makeRegistration = () => ({
  editorRef: createRef<DocxEditorRef | null>(),
  requestEditMode: () => true,
  editable: false,
});

describe("active-docx-store instance-token guard", () => {
  beforeEach(() => {
    // Reset between tests; the store is module-level singleton.
    useActiveDocxStore.setState({ byKey: {} });
  });

  test("registerEditor returns a unique token per call", () => {
    const a = useActiveDocxStore
      .getState()
      .registerEditor("ent_1", "fld_1", makeRegistration());
    const b = useActiveDocxStore
      .getState()
      .registerEditor("ent_2", "fld_1", makeRegistration());
    expect(typeof a).toBe("symbol");
    expect(typeof b).toBe("symbol");
    expect(a).not.toBe(b);
  });

  test("a stale unregister from a replaced instance is a no-op", () => {
    // Instance A mounts.
    const tokenA = useActiveDocxStore
      .getState()
      .registerEditor("ent_1", "fld_1", makeRegistration());

    // Instance B mounts for the same document, overwriting A's slot.
    const registrationB = makeRegistration();
    const tokenB = useActiveDocxStore
      .getState()
      .registerEditor("ent_1", "fld_1", registrationB);
    expect(tokenA).not.toBe(tokenB);

    // Instance A's cleanup runs late — must NOT delete B's slot.
    useActiveDocxStore.getState().unregisterEditor("ent_1", "fld_1", tokenA);

    const slot =
      useActiveDocxStore.getState().byKey[activeDocxKey("ent_1", "fld_1")];
    expect(slot).toBeDefined();
    expect(slot?.token).toBe(tokenB);
    expect(slot?.registration).toBe(registrationB);
  });

  test("the live owner can unregister itself cleanly", () => {
    const token = useActiveDocxStore
      .getState()
      .registerEditor("ent_1", "fld_1", makeRegistration());
    useActiveDocxStore.getState().unregisterEditor("ent_1", "fld_1", token);
    expect(
      useActiveDocxStore.getState().byKey[activeDocxKey("ent_1", "fld_1")],
    ).toBeUndefined();
  });

  test("updateEditable is scoped to the matching token", () => {
    const tokenA = useActiveDocxStore
      .getState()
      .registerEditor("ent_1", "fld_1", makeRegistration());

    // Owner toggles editable — applied.
    useActiveDocxStore
      .getState()
      .updateEditable("ent_1", "fld_1", true, tokenA);
    expect(
      useActiveDocxStore.getState().byKey[activeDocxKey("ent_1", "fld_1")]
        ?.registration.editable,
    ).toBe(true);

    // Replace with instance B.
    useActiveDocxStore
      .getState()
      .registerEditor("ent_1", "fld_1", makeRegistration());
    // Stale write from A — must be ignored.
    useActiveDocxStore
      .getState()
      .updateEditable("ent_1", "fld_1", false, tokenA);
    expect(
      useActiveDocxStore.getState().byKey[activeDocxKey("ent_1", "fld_1")]
        ?.registration.editable,
    ).toBe(false); // B's initial registration value, not A's stale write
  });

  test("two file fields of the same entity register independently", () => {
    const registrationA = makeRegistration();
    const registrationB = makeRegistration();
    const tokenA = useActiveDocxStore
      .getState()
      .registerEditor("ent_1", "fld_1", registrationA);
    const tokenB = useActiveDocxStore
      .getState()
      .registerEditor("ent_1", "fld_2", registrationB);

    // Both live at once — neither overwrites the other's slot.
    expect(
      useActiveDocxStore.getState().byKey[activeDocxKey("ent_1", "fld_1")]
        ?.registration,
    ).toBe(registrationA);
    expect(
      useActiveDocxStore.getState().byKey[activeDocxKey("ent_1", "fld_2")]
        ?.registration,
    ).toBe(registrationB);

    // Unregistering one field leaves the sibling field intact.
    useActiveDocxStore.getState().unregisterEditor("ent_1", "fld_1", tokenA);
    expect(
      useActiveDocxStore.getState().byKey[activeDocxKey("ent_1", "fld_1")],
    ).toBeUndefined();
    const survivor =
      useActiveDocxStore.getState().byKey[activeDocxKey("ent_1", "fld_2")];
    expect(survivor?.token).toBe(tokenB);
    expect(survivor?.registration).toBe(registrationB);
  });
});
