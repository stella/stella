import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { ENTITY_NAME_MAX_LENGTH } from "@stll/api-contract";

import messages from "@/i18n/langs/en.json" with { type: "json" };
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000" });
const { act, cleanup, fireEvent, render, screen } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { TaskNameField } = await import("./task-name-field");

afterEach(cleanup);
afterAll(async () => {
  await unregisterDomEnvironment();
});

const renderField = (
  onRename: (name: string, showError: (message: string) => void) => void,
) =>
  render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <FormattingProvider locale="en" timeZone="UTC">
        <TaskNameField
          autoEdit={false}
          name="File the reply"
          onRename={onRename}
        />
      </FormattingProvider>
    </IntlProvider>,
  );

const editName = async (value: string) => {
  fireEvent.click(await screen.findByRole("button"));
  const input = await screen.findByRole("textbox");
  fireEvent.change(input, { target: { value } });
  return input;
};

test("the input stops at the name limit and shows its length near it", async () => {
  renderField(() => {});
  const input = await editName("x".repeat(ENTITY_NAME_MAX_LENGTH - 1));

  expect(input.getAttribute("maxlength")).toBe(String(ENTITY_NAME_MAX_LENGTH));
  expect(screen.getByText(/254\/255/u)).toBeDefined();
});

test("a refused name stays in the input with the reason beside it", async () => {
  let refuse: ((message: string) => void) | undefined;
  renderField((_name, showError) => {
    refuse = showError;
  });
  const typed = "Reply to the statement of defence";
  fireEvent.keyDown(await editName(typed), { key: "Enter" });
  await act(async () => {
    await Promise.resolve();
  });
  expect(screen.queryByRole("textbox")).toBeNull();

  act(() => refuse?.("Too long"));

  const input = await screen.findByRole("textbox");
  expect(input).toHaveProperty("value", typed);
  expect(screen.getByRole("alert").textContent).toBe("Too long");
});
