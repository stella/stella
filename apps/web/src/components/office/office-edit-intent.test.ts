import { describe, expect, test } from "bun:test";

import {
  INITIAL_OFFICE_EDIT_INTENT_STATE,
  isOfficeEditIntentKey,
  registerOfficeEditIntentKeystroke,
} from "@/components/office/office-edit-intent";

const keyEvent = (key: string) => ({
  altKey: false,
  ctrlKey: false,
  isComposing: false,
  key,
  metaKey: false,
  repeat: false,
});

describe("Office edit intent", () => {
  test("requires three edit keystrokes in one short burst", () => {
    const first = registerOfficeEditIntentKeystroke({
      state: INITIAL_OFFICE_EDIT_INTENT_STATE,
      timestamp: 0,
    });
    const second = registerOfficeEditIntentKeystroke({
      state: first.state,
      timestamp: 500,
    });
    const third = registerOfficeEditIntentKeystroke({
      state: second.state,
      timestamp: 1000,
    });

    expect(first.shouldPrompt).toBeFalse();
    expect(second.shouldPrompt).toBeFalse();
    expect(third.shouldPrompt).toBeTrue();
  });

  test("does not combine isolated keystrokes", () => {
    const first = registerOfficeEditIntentKeystroke({
      state: INITIAL_OFFICE_EDIT_INTENT_STATE,
      timestamp: 0,
    });
    const second = registerOfficeEditIntentKeystroke({
      state: first.state,
      timestamp: 2000,
    });
    const third = registerOfficeEditIntentKeystroke({
      state: second.state,
      timestamp: 4000,
    });

    expect(third.shouldPrompt).toBeFalse();
  });

  test("suppresses repeat prompts until the cooldown expires", () => {
    const first = registerOfficeEditIntentKeystroke({
      state: INITIAL_OFFICE_EDIT_INTENT_STATE,
      timestamp: 0,
    });
    const second = registerOfficeEditIntentKeystroke({
      state: first.state,
      timestamp: 500,
    });
    const prompted = registerOfficeEditIntentKeystroke({
      state: second.state,
      timestamp: 1000,
    });
    const suppressed = registerOfficeEditIntentKeystroke({
      state: prompted.state,
      timestamp: 2000,
    });

    expect(prompted.shouldPrompt).toBeTrue();
    expect(suppressed.shouldPrompt).toBeFalse();

    const afterCooldownFirst = registerOfficeEditIntentKeystroke({
      state: suppressed.state,
      timestamp: 11_000,
    });
    const afterCooldownSecond = registerOfficeEditIntentKeystroke({
      state: afterCooldownFirst.state,
      timestamp: 11_500,
    });
    const afterCooldownThird = registerOfficeEditIntentKeystroke({
      state: afterCooldownSecond.state,
      timestamp: 12_000,
    });

    expect(afterCooldownThird.shouldPrompt).toBeTrue();
  });

  test("ignores shortcuts, navigation, and held keys", () => {
    expect(isOfficeEditIntentKey(keyEvent("a"))).toBeTrue();
    expect(isOfficeEditIntentKey(keyEvent("ArrowRight"))).toBeFalse();
    expect(
      isOfficeEditIntentKey({ ...keyEvent("v"), metaKey: true }),
    ).toBeFalse();
    expect(
      isOfficeEditIntentKey({ ...keyEvent("a"), repeat: true }),
    ).toBeFalse();
  });
});
