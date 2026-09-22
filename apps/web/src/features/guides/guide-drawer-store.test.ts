import { beforeEach, describe, expect, test } from "bun:test";

import {
  GUIDE_DRAWER_OPEN_SOURCES,
  useGuideDrawerStore,
} from "@/features/guides/guide-drawer-store";

beforeEach(() => {
  useGuideDrawerStore.setState(useGuideDrawerStore.getInitialState(), true);
});

describe("guide drawer attention", () => {
  test("only closing the onboarding-opened drawer points back to its sidebar button", () => {
    const directOpen = useGuideDrawerStore.getState().open;
    directOpen();
    useGuideDrawerStore.getState().setOpen(false);
    expect(useGuideDrawerStore.getState().attentionSequence).toBe(0);

    useGuideDrawerStore.getState().open(GUIDE_DRAWER_OPEN_SOURCES.onboarding);
    useGuideDrawerStore.getState().setOpen(true);
    useGuideDrawerStore.getState().setOpen(false);
    expect(useGuideDrawerStore.getState().attentionSequence).toBe(1);

    useGuideDrawerStore.getState().setOpen(false);
    directOpen();
    useGuideDrawerStore.getState().setOpen(false);
    expect(useGuideDrawerStore.getState().attentionSequence).toBe(1);
  });
});
