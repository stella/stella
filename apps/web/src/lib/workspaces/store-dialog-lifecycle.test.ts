import { beforeEach, describe, expect, test } from "bun:test";

import { useCreateMatterStore } from "./create-matter-store";
import { useQuickEntryStore } from "./quick-entry-store";

beforeEach(() => {
  useCreateMatterStore.setState({ dialog: { status: "closed" } });
  useQuickEntryStore.setState({ dialog: { status: "closed" } });
});

describe("store-driven dialog close lifecycle", () => {
  test("matter payload and focus target survive until the close completes", () => {
    const client = {
      id: "client",
      displayName: "Client",
      type: "person",
    } as const;
    const onCreated = () => undefined;
    useCreateMatterStore.getState().openDialog({ client, onCreated });
    const returnFocus = useCreateMatterStore.getState().returnFocus;
    useCreateMatterStore.getState().closeDialog();
    expect(useCreateMatterStore.getState().dialog).toEqual({
      status: "closing",
      draftClient: client,
      onCreated,
    });
    expect(useCreateMatterStore.getState().returnFocus).toBe(returnFocus);
    useCreateMatterStore.getState().finishClosing();
    expect(useCreateMatterStore.getState().dialog).toEqual({
      status: "closed",
    });
  });

  test("time-entry scope survives until the close completes", () => {
    const scope = { userId: "user", organizationId: "organization" };
    useQuickEntryStore.getState().openDialog(scope);
    const returnFocus = useQuickEntryStore.getState().returnFocus;
    useQuickEntryStore.getState().closeDialog();
    expect(useQuickEntryStore.getState().dialog).toEqual({
      status: "closing",
      ...scope,
    });
    expect(useQuickEntryStore.getState().returnFocus).toBe(returnFocus);
    useQuickEntryStore.getState().finishClosing();
    expect(useQuickEntryStore.getState().dialog).toEqual({ status: "closed" });
  });

  test("a late close completion leaves a newly opened dialog intact", () => {
    for (const store of [useCreateMatterStore, useQuickEntryStore]) {
      store.getState().closeDialog();
      store.getState().finishClosing();
      expect(store.getState().dialog.status).toBe("closed");
    }
    useCreateMatterStore.getState().openDialog();
    useCreateMatterStore.getState().closeDialog();
    useCreateMatterStore.getState().openDialog();
    useCreateMatterStore.getState().finishClosing();
    expect(useCreateMatterStore.getState().dialog.status).toBe("open");
    useQuickEntryStore
      .getState()
      .openDialog({ userId: "user", organizationId: "organization" });
    useQuickEntryStore.getState().closeDialog();
    useQuickEntryStore
      .getState()
      .openDialog({ userId: "other", organizationId: "organization" });
    useQuickEntryStore.getState().finishClosing();
    expect(useQuickEntryStore.getState().dialog).toEqual({
      status: "open",
      userId: "other",
      organizationId: "organization",
    });
  });
});
