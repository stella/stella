import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

GlobalRegistrator.register();
const previousActEnvironment: unknown = Reflect.get(
  globalThis,
  "IS_REACT_ACT_ENVIRONMENT",
);
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { cleanup, fireEvent, render } = await import("@testing-library/react");
const { Checkbox } = await import("./checkbox");
const { SettingsRow, settingsRowIds, SettingsSection } =
  await import("./settings");
const { Switch } = await import("./switch");

afterEach(() => {
  cleanup();
});

afterAll(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousActEnvironment);
  await unregisterDomEnvironment();
});

const CONTROLS = {
  checkbox: Checkbox,
  switch: Switch,
} as const;

describe("a label row", () => {
  for (const [role, Control] of Object.entries(CONTROLS)) {
    test(`flips its ${role} once, pressed on the control or on the text`, () => {
      const onCheckedChange = mock((_checked: boolean) => undefined);
      const ids = settingsRowIds("digest");
      const view = render(
        <SettingsSection title="Chat">
          <SettingsRow
            description="Send a summary every morning"
            id="digest"
            interaction="label"
            title="Daily digest"
          >
            <Control
              aria-describedby={ids.description}
              aria-labelledby={ids.label}
              onCheckedChange={onCheckedChange}
            />
          </SettingsRow>
        </SettingsSection>,
      );
      const control = view.getByRole(role, { name: "Daily digest" });

      fireEvent.click(control);
      expect(onCheckedChange.mock.calls).toEqual([[true]]);

      fireEvent.click(view.getByText("Send a summary every morning"));
      expect(onCheckedChange.mock.calls).toEqual([[true], [false]]);
    });
  }
});
