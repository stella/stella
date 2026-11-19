import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import messages from "@/i18n/langs/en.json" with { type: "json" };

GlobalRegistrator.register({
  url: "http://localhost:3000/settings/organization/ai",
});
const { cleanup, fireEvent, render, screen } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { VerificationDecisionModelControl } =
  await import("./verification-decision-model-card");

afterEach(() => {
  cleanup();
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

const copy = messages.settings.organization.verificationDecisionModel;

type MountOptions = {
  enabled: boolean;
  available: boolean;
  canEdit?: boolean;
  pending?: boolean;
};

const mount = ({
  enabled,
  available,
  canEdit = true,
  pending = false,
}: MountOptions) => {
  const changes: boolean[] = [];
  render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <VerificationDecisionModelControl
        setting={{ enabled, available }}
        canEdit={canEdit}
        pending={pending}
        onChange={(next) => {
          changes.push(next);
        }}
      />
    </IntlProvider>,
  );
  const control = screen.getByRole("switch", { name: copy.title });
  return { control, changes };
};

const isDisabled = (control: HTMLElement) =>
  control.getAttribute("aria-disabled") === "true" ||
  control.hasAttribute("disabled") ||
  Object.hasOwn(control.dataset, "disabled");

test("off with a decision model available, it can be turned on", () => {
  const { control, changes } = mount({ enabled: false, available: true });
  expect(control.getAttribute("aria-checked")).toBe("false");
  expect(isDisabled(control)).toBe(false);
  expect(screen.queryByText(copy.unavailable)).toBeNull();
  fireEvent.click(control);
  expect(changes).toEqual([true]);
});

test("off with no decision model, it is disabled and says why", () => {
  const { control, changes } = mount({ enabled: false, available: false });
  expect(control.getAttribute("aria-checked")).toBe("false");
  expect(isDisabled(control)).toBe(true);
  expect(screen.getByText(copy.unavailable)).toBeDefined();
  fireEvent.click(control);
  expect(changes).toEqual([]);
});

test("left on after its decision model went away, it can still be turned off", () => {
  const { control, changes } = mount({ enabled: true, available: false });
  expect(control.getAttribute("aria-checked")).toBe("true");
  expect(isDisabled(control)).toBe(false);
  expect(screen.getByText(copy.unavailable)).toBeDefined();
  fireEvent.click(control);
  expect(changes).toEqual([false]);
});

test.each([
  { canEdit: false, pending: false },
  { canEdit: true, pending: true },
])(
  "a member who cannot edit, or a save in flight, disables it ($canEdit, $pending)",
  ({ canEdit, pending }) => {
    const { control } = mount({
      enabled: true,
      available: true,
      canEdit,
      pending,
    });
    expect(isDisabled(control)).toBe(true);
  },
);
