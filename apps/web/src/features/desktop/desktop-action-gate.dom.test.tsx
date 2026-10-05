import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import messages from "@/i18n/langs/en.json";

GlobalRegistrator.register({ url: "http://localhost:3000/" });

const { act } = await import("react");
const { cleanup, fireEvent, render, screen } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { DesktopRequiredDialog } =
  await import("@/features/desktop/desktop-action-gate");

afterEach(async () => {
  await act(async () => {
    cleanup();
  });
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const gate = messages.workspaces.files.desktopGate;

type MountOptions = {
  action: "edit-file" | "sign-pdf";
  required: "none" | "outdated" | null;
};

const mount = ({ action, required }: MountOptions) => {
  const calls: string[] = [];
  render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <DesktopRequiredDialog
        action={action}
        onClose={() => {
          calls.push("close");
        }}
        onConnect={() => {
          calls.push("connect");
        }}
        required={required}
      />
    </IntlProvider>,
  );
  return calls;
};

describe("DesktopRequiredDialog", () => {
  test("without the app, says why signing needs it and offers the download", async () => {
    mount({ action: "sign-pdf", required: "none" });

    expect(await screen.findByText(gate.signNone)).toBeDefined();
    expect(screen.getByText(gate.signReason)).toBeDefined();
    expect(screen.getAllByRole("link").length).toBeGreaterThan(0);
  });

  test("an app that is installed but not linked can be connected instead", async () => {
    const calls = mount({ action: "sign-pdf", required: "none" });

    fireEvent.click(
      await screen.findByRole("button", { name: gate.alreadyInstalled }),
    );
    expect(calls).toEqual(["connect"]);
  });

  test("an outdated app is asked to update, with no connect offer", async () => {
    mount({ action: "edit-file", required: "outdated" });

    expect(await screen.findByText(gate.editOutdated)).toBeDefined();
    expect(screen.getByText(gate.editReason)).toBeDefined();
    expect(
      screen.queryByRole("button", { name: gate.alreadyInstalled }),
    ).toBeNull();
  });

  test("renders nothing while no requirement is pending", () => {
    mount({ action: "sign-pdf", required: null });

    expect(screen.queryByText(gate.signNone)).toBeNull();
  });
});
