import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, mock, spyOn, test } from "bun:test";

import { DEFAULT_VARCHAR_MAX_LENGTH } from "@stll/api-contract/limits";

import messages from "@/i18n/langs/en.json";
import { unregisterDomEnvironment } from "@/test-dom-environment";

// Spies created in a test stay attached if it fails before restoring them.
afterEach(() => {
  mock.restore();
});

GlobalRegistrator.register({ url: "http://localhost:3000/" });

const { toAPIError } = await import("@/lib/errors/api");

const TOO_LONG = toAPIError({
  status: 422,
  value: {
    message: "Invalid request",
    code: "validation",
    issues: [
      {
        field: "name",
        constraint: "maxLength",
        limit: DEFAULT_VARCHAR_MAX_LENGTH,
      },
    ],
  },
});
const TOO_LONG_MESSAGE = messages.errors.apiCodes.validationTooLong.replace(
  "{limit, number}",
  () => String(DEFAULT_VARCHAR_MAX_LENGTH),
);

const { cleanup, fireEvent, render, screen, waitFor } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { stellaToast } = await import("@stll/ui/toast");
const { InlineEdit } = await import("@/components/inline-edit");
const { SaveAsTemplateDialogView } =
  await import("@/routes/_protected.workspaces/$workspaceId/-components/view/save-as-template-dialog");
const { CreateRateTableForm } =
  await import("@/routes/_protected.workspaces/$workspaceId/-components/billing/rate-management-dialog");

const inputMaxLength = (element: HTMLElement) => {
  expect(element).toBeInstanceOf(HTMLInputElement);
  return element instanceof HTMLInputElement ? element.maxLength : undefined;
};

const withIntl = (node: React.ReactNode) => (
  <IntlProvider locale="en" messages={messages} timeZone="UTC">
    {node}
  </IntlProvider>
);

afterEach(cleanup);
afterAll(async () => {
  cleanup();
  await unregisterDomEnvironment();
});

test("an inline rename stops at the shared name limit", () => {
  render(
    withIntl(
      <InlineEdit
        inputAriaLabel="Name"
        maxLength={DEFAULT_VARCHAR_MAX_LENGTH}
        onCancel={() => undefined}
        onChange={() => undefined}
        onCommit={() => undefined}
        value="Draft"
      />,
    ),
  );

  expect(inputMaxLength(screen.getByRole("textbox", { name: "Name" }))).toBe(
    DEFAULT_VARCHAR_MAX_LENGTH,
  );
});

test("saving a view template shows the server's length verdict under the name", async () => {
  spyOn(stellaToast, "add").mockReturnValue("toast-id");
  const createTemplateCalls: string[] = [];
  render(
    withIntl(
      <SaveAsTemplateDialogView
        defaultName="Review"
        onOpenChange={() => undefined}
        open
        pending={false}
        save={(name, handlers) => {
          createTemplateCalls.push(name);
          handlers.onError(TOO_LONG);
          handlers.onSettled();
        }}
      />,
    ),
  );

  const input = await screen.findByPlaceholderText(
    messages.workspaces.views.templates.namePlaceholder,
  );
  expect(inputMaxLength(input)).toBe(DEFAULT_VARCHAR_MAX_LENGTH);
  fireEvent.submit(input.closest("form") ?? input);

  await screen.findByText(TOO_LONG_MESSAGE);
  expect(createTemplateCalls).toEqual(["Review"]);

  // Editing the name clears the stale verdict.
  fireEvent.change(input, { target: { value: "Shorter" } });
  await waitFor(() => {
    expect(screen.queryByText(TOO_LONG_MESSAGE)).toBeNull();
  });
});

test("creating a rate table shows the server's length verdict under the name", async () => {
  const submitted: string[] = [];
  render(
    withIntl(
      <CreateRateTableForm
        onCancel={() => undefined}
        onSubmit={async (values) => {
          submitted.push(values.name);
          return TOO_LONG_MESSAGE;
        }}
      />,
    ),
  );

  const input = screen.getByPlaceholderText(
    messages.billing.rates.tableNamePlaceholder,
  );
  expect(inputMaxLength(input)).toBe(DEFAULT_VARCHAR_MAX_LENGTH);
  fireEvent.change(input, { target: { value: "Standard" } });
  fireEvent.submit(input.closest("form") ?? input);

  await screen.findByText(TOO_LONG_MESSAGE);
  expect(submitted).toEqual(["Standard"]);
});
