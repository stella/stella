import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/", width: 1280 });

const testing = await import("@testing-library/react");
const { useState } = await import("react");
const { IntlProvider } = await import("use-intl");
const { default: messages } = await import("@/i18n/langs/en.json");
const { TimeZonePicker } = await import("@/lib/time-zone-picker");

afterEach(() => {
  testing.cleanup();
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

describe("time zone picker", () => {
  test("searches and selects a zone while keeping the complete selected name visible", async () => {
    const changes: string[] = [];
    const Host = () => {
      const [value, setValue] = useState("America/New_York");
      return (
        <TimeZonePicker
          id="organization-time-zone"
          jurisdictionCountries={["CZ"]}
          label="Time zone"
          onValueChange={(zone) => {
            changes.push(zone);
            setValue(zone);
          }}
          value={value}
        />
      );
    };
    const ui = testing.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <Host />
      </IntlProvider>,
    );
    const trigger = ui.getByRole("combobox", {
      name: "Time zone: America/New York",
    });
    expect(trigger.textContent).toContain("America/New York");

    await testing.act(async () => {
      testing.fireEvent.click(trigger);
    });
    const input = ui.getByRole("combobox", { name: messages.common.search });
    if (!(input instanceof HTMLInputElement)) {
      throw new TypeError("Expected the time zone search input");
    }
    await testing.act(async () => {
      testing.fireEvent.input(input, {
        target: { value: "Prague" },
        inputType: "insertText",
      });
    });

    await testing.waitFor(() =>
      expect(
        ui.getAllByRole("option").map((option) => option.textContent),
      ).toEqual([expect.stringContaining("Europe/Prague")]),
    );
    await testing.act(async () => {
      testing.fireEvent.keyDown(input, { key: "ArrowDown" });
      testing.fireEvent.keyDown(input, { key: "Enter" });
    });

    await testing.waitFor(() => expect(changes).toEqual(["Europe/Prague"]));
    expect(trigger.getAttribute("aria-label")).toBe("Time zone: Europe/Prague");
    expect(trigger.textContent).toContain("Europe/Prague");
  });

  test("shows the complete follow-jurisdiction choice on the trigger", () => {
    const label =
      messages.settings.organization.timeZone.followingJurisdiction.replace(
        "{timeZone}",
        "Europe/Prague",
      );
    const ui = testing.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <TimeZonePicker
          follow={{ value: "follow-primary", label, zone: "Europe/Prague" }}
          id="follow-time-zone"
          label="Time zone"
          onValueChange={() => {}}
          value="follow-primary"
        />
      </IntlProvider>,
    );
    const trigger = ui.getByRole("combobox", { name: `Time zone: ${label}` });
    expect(trigger.textContent).toContain(label);
  });
});
