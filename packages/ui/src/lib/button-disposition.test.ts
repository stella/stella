import { describe, expect, test } from "bun:test";

import {
  BUTTON_DISPOSITION,
  blockDisabledActivation,
  blockDisabledKeyActivation,
  resolveButtonDisposition,
} from "./button-disposition";

const disposition = (
  input: Parameters<typeof resolveButtonDisposition>[0],
): string => resolveButtonDisposition(input);

describe("resolveButtonDisposition", () => {
  test("an available button is plain enabled", () => {
    expect(
      disposition({ disabled: undefined, loading: undefined, tooltip: "Save" }),
    ).toBe(BUTTON_DISPOSITION.enabled);
    expect(
      disposition({ disabled: false, loading: false, tooltip: "Save" }),
    ).toBe(BUTTON_DISPOSITION.enabled);
  });

  test("stays natively disabled when there is no tooltip to reach", () => {
    expect(
      disposition({
        disabled: true,
        loading: undefined,
        tooltip: undefined,
      }),
    ).toBe(BUTTON_DISPOSITION.nativeDisabled);
    expect(
      disposition({ disabled: undefined, loading: true, tooltip: undefined }),
    ).toBe(BUTTON_DISPOSITION.nativeDisabled);
  });

  test("switches to the accessible-disabled pattern to keep a tooltip reachable", () => {
    expect(
      disposition({
        disabled: true,
        loading: undefined,
        tooltip: "Save first",
      }),
    ).toBe(BUTTON_DISPOSITION.accessibleDisabled);
    expect(
      disposition({ disabled: undefined, loading: true, tooltip: "Saving" }),
    ).toBe(BUTTON_DISPOSITION.accessibleDisabled);
  });

  // The values `renderTooltipTrigger` refuses to mount a popup for must not
  // pull the button off the native `disabled` attribute either.
  test.each([undefined, null, "", false])(
    "treats %p as no tooltip",
    (tooltip) => {
      expect(disposition({ disabled: true, loading: undefined, tooltip })).toBe(
        BUTTON_DISPOSITION.nativeDisabled,
      );
    },
  );
});

type RecordedEvent = {
  key: string;
  preventDefault: () => void;
  preventBaseUIHandler: () => void;
  defaultPrevented: boolean;
  baseHandlerPrevented: boolean;
};

const recordEvent = (key = ""): RecordedEvent => {
  const event: RecordedEvent = {
    key,
    defaultPrevented: false,
    baseHandlerPrevented: false,
    preventDefault: () => {
      event.defaultPrevented = true;
    },
    preventBaseUIHandler: () => {
      event.baseHandlerPrevented = true;
    },
  };
  return event;
};

describe("activation blockers", () => {
  test("a pointer activation is prevented and the caller's handler suppressed", () => {
    const event = recordEvent();

    blockDisabledActivation(event);

    // `preventDefault` is what stops a `type="submit"` button from submitting.
    expect(event.defaultPrevented).toBe(true);
    // `preventBaseUIHandler` stops the handlers merged to the left, i.e. the
    // caller's own `onClick`.
    expect(event.baseHandlerPrevented).toBe(true);
  });

  test.each(["Enter", " ", "ArrowDown"])(
    "the %p key cannot activate the button",
    (key) => {
      const event = recordEvent(key);

      blockDisabledKeyActivation(event);

      expect(event.defaultPrevented).toBe(true);
      expect(event.baseHandlerPrevented).toBe(true);
    },
  );

  test("Tab keeps its default so focus can still leave the button", () => {
    const event = recordEvent("Tab");

    blockDisabledKeyActivation(event);

    expect(event.defaultPrevented).toBe(false);
    expect(event.baseHandlerPrevented).toBe(true);
  });
});
