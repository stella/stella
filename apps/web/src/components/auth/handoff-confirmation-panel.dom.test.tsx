import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, mock, test } from "bun:test";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/auth/handoff" });
const { cleanup, fireEvent, render } = await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const messages = (await import("@/i18n/langs/en.json")).default;
const { HandoffConfirmationPanel } =
  await import("./handoff-confirmation-panel");

afterEach(cleanup);
afterAll(async () => {
  await unregisterDomEnvironment();
});

const renderPanel = (submissionStatus: "ready" | "submitting") => {
  const onConfirm = mock(() => undefined);
  const onCancel = mock(() => undefined);
  const ui = render(
    <IntlProvider locale="en" messages={messages}>
      <HandoffConfirmationPanel
        email="zofie@example.test"
        organizationName="Žofie Nováková"
        submissionStatus={submissionStatus}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    </IntlProvider>,
  );
  return { onCancel, onConfirm, ui };
};

test("a pending handoff names the account and waits for confirmation", () => {
  const { onCancel, onConfirm, ui } = renderPanel("ready");

  expect(ui.getByText("zofie@example.test")).toBeDefined();
  expect(ui.getByText("Žofie Nováková")).toBeDefined();
  expect(onConfirm).not.toHaveBeenCalled();

  fireEvent.click(ui.getByRole("button", { name: messages.common.confirm }));
  expect(onConfirm).toHaveBeenCalledTimes(1);
  expect(onCancel).not.toHaveBeenCalled();
});

test("a submitting handoff keeps both actions unavailable", () => {
  const { onCancel, onConfirm, ui } = renderPanel("submitting");
  const confirm = ui.getByRole("button", { name: messages.common.confirm });
  const cancel = ui.getByRole("button", { name: messages.common.cancel });

  expect(ui.getByText("zofie@example.test")).toBeDefined();
  expect(ui.getByText("Žofie Nováková")).toBeDefined();
  expect(confirm.hasAttribute("disabled")).toBe(true);
  expect(cancel.hasAttribute("disabled")).toBe(true);
  expect(onConfirm).not.toHaveBeenCalled();
  expect(onCancel).not.toHaveBeenCalled();

  fireEvent.click(confirm);
  fireEvent.click(cancel);
  expect(onConfirm).not.toHaveBeenCalled();
  expect(onCancel).not.toHaveBeenCalled();
});
