import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import {
  WORKSPACE_STATUS,
  type WorkspaceStatus,
} from "@stll/api-contract/workspace-status";
import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import messages from "@/i18n/langs/en.json";

GlobalRegistrator.register({ url: "http://localhost:3000/" });

const { cleanup, render } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { MatterColorContextPicker, MatterColorPicker } =
  await import("./matter-color-picker");

afterEach(cleanup);
afterAll(async () => {
  cleanup();
  await unregisterDomEnvironment();
});

const LABEL = "Change color";

const renderPickers = (status: WorkspaceStatus) => {
  const matter = { color: null, id: "matter-1", status };
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <IntlProvider locale="en" messages={messages}>
        <MatterColorPicker label={LABEL} matter={matter}>
          <span data-testid="breadcrumb-icon" />
        </MatterColorPicker>
        <MatterColorContextPicker label={LABEL} matter={matter}>
          <span data-testid="sidebar-icon" />
        </MatterColorContextPicker>
      </IntlProvider>
    </QueryClientProvider>,
  );
};

test("an active matter offers one named button per picker, never a button inside a button", () => {
  const view = renderPickers(WORKSPACE_STATUS.active);

  const buttons = view.getAllByRole("button");
  expect(buttons).toHaveLength(2);
  for (const button of buttons) {
    expect(button.getAttribute("aria-label")).toBe(LABEL);
    expect(button.querySelector("button, [role='button']")).toBeNull();
  }
});

test.each([WORKSPACE_STATUS.archived, WORKSPACE_STATUS.deleting])(
  "a %s matter shows its icon without a color picker",
  (status) => {
    const view = renderPickers(status);

    expect(view.queryAllByRole("button")).toHaveLength(0);
    expect(view.getByTestId("breadcrumb-icon")).toBeDefined();
    expect(view.getByTestId("sidebar-icon")).toBeDefined();
  },
);
