import type { ReactNode } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import {
  MATTER_STEWARD_HANDOVER_REQUIRED_CODE,
  MATTER_VISIBILITY,
} from "@stll/api-contract/matter-visibility";
import type { MatterVisibility } from "@stll/api-contract/matter-visibility";
import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/" });
const { act } = await import("react");
const { cleanup, fireEvent, render, screen, waitFor } =
  await import("@testing-library/react");
const { QueryClient } = await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { ToastProvider, stellaToast } = await import("@stll/ui/toast");
const { toAPIError } = await import("@/lib/errors/api");
const { resetUserErrorReportDedupeForTests } =
  await import("@/lib/errors/user-toast");
const messages = (await import("@/i18n/langs/en.json")).default;
const { MatterVisibilityField } = await import("./visibility-section");

type FieldProps = Parameters<typeof MatterVisibilityField>[0];
type Mutation = FieldProps["updateWorkspace"];
type Call = {
  variables: Parameters<Mutation["mutate"]>[0];
  callbacks: Parameters<Mutation["mutate"]>[1];
};

const WORKSPACE_ID = "matter-share-purchase";
const LABELS = {
  [MATTER_VISIBILITY.allMembers]: messages.workspaces.visibility.allMembers,
  [MATTER_VISIBILITY.adminsAndAssigned]:
    messages.workspaces.visibility.adminsAndAssigned,
  [MATTER_VISIBILITY.assignedOnly]: messages.workspaces.visibility.assignedOnly,
} as const satisfies Record<MatterVisibility, string>;

const wrapper = ({ children }: { children: ReactNode }) => (
  <IntlProvider locale="en" messages={messages} timeZone="UTC">
    <ToastProvider>{children}</ToastProvider>
  </IntlProvider>
);

type MountOptions = {
  editable: boolean;
  visibility: MatterVisibility;
};

const mount = ({ editable, visibility }: MountOptions) => {
  const calls: Call[] = [];
  render(
    <MatterVisibilityField
      editable={editable}
      updateWorkspace={{
        isPending: false,
        mutate: (variables, callbacks) => {
          calls.push({ variables, callbacks });
        },
      }}
      visibility={visibility}
      workspaceId={WORKSPACE_ID}
    />,
    { wrapper },
  );
  return calls;
};

const trigger = () =>
  screen.getByRole("combobox", { name: messages.workspaces.visibility.label });

const pick = async (visibility: MatterVisibility) => {
  await act(async () => {
    fireEvent.click(trigger());
  });
  const option = screen
    .getAllByRole("option")
    .find((candidate) => candidate.textContent.startsWith(LABELS[visibility]));
  if (!option) {
    throw new Error(`Expected the ${visibility} option`);
  }
  await act(async () => {
    fireEvent.pointerDown(option, { pointerType: "mouse" });
    fireEvent.click(option);
  });
};

afterEach(async () => {
  await act(async () => {
    stellaToast.dismiss();
  });
  cleanup();
  resetUserErrorReportDedupeForTests();
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

test("a person who may not change visibility sees it without a working control", () => {
  mount({ editable: false, visibility: MATTER_VISIBILITY.adminsAndAssigned });

  expect(trigger().textContent).toContain(
    messages.workspaces.visibility.adminsAndAssigned,
  );
  expect(
    trigger().hasAttribute("disabled") ||
      trigger().getAttribute("aria-disabled") === "true" ||
      Object.hasOwn(trigger().dataset, "disabled"),
  ).toBe(true);
});

test("narrowing applies at once, without confirmation", async () => {
  const calls = mount({
    editable: true,
    visibility: MATTER_VISIBILITY.allMembers,
  });

  await pick(MATTER_VISIBILITY.assignedOnly);

  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(calls.map(({ variables }) => variables)).toEqual([
    {
      workspaceId: WORKSPACE_ID,
      update: { type: "visibility", value: MATTER_VISIBILITY.assignedOnly },
    },
  ]);
});

test.each([
  {
    from: MATTER_VISIBILITY.assignedOnly,
    to: MATTER_VISIBILITY.adminsAndAssigned,
    audience: messages.workspaces.visibility.widenToAdminsAndAssigned,
  },
  {
    from: MATTER_VISIBILITY.adminsAndAssigned,
    to: MATTER_VISIBILITY.allMembers,
    audience: messages.workspaces.visibility.widenToAllMembers,
  },
])(
  "widening $from to $to names who gains access and sends the confirmation only once confirmed",
  async ({ from, to, audience }) => {
    const calls = mount({ editable: true, visibility: from });

    await pick(to);

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain(audience);
    expect(calls).toHaveLength(0);

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", {
          name: messages.workspaces.visibility.widenConfirm,
        }),
      );
    });
    expect(calls.map(({ variables }) => variables)).toEqual([
      {
        workspaceId: WORKSPACE_ID,
        update: { type: "visibility", value: to, confirmWidening: true },
      },
    ]);
  },
);

test("cancelling a widening sends nothing", async () => {
  const calls = mount({
    editable: true,
    visibility: MATTER_VISIBILITY.assignedOnly,
  });

  await pick(MATTER_VISIBILITY.allMembers);
  await screen.findByRole("alertdialog");
  await act(async () => {
    fireEvent.click(
      screen.getByRole("button", { name: messages.common.cancel }),
    );
  });

  expect(calls).toHaveLength(0);
});

test("a narrowing that would leave nobody to open the matter explains the handover", async () => {
  const calls = mount({
    editable: true,
    visibility: MATTER_VISIBILITY.adminsAndAssigned,
  });

  await pick(MATTER_VISIBILITY.assignedOnly);
  const call = calls.at(0);
  if (!call) {
    throw new Error("Expected a visibility update");
  }
  await act(async () => {
    call.callbacks?.onError?.(
      toAPIError({
        status: 409,
        value: {
          code: MATTER_STEWARD_HANDOVER_REQUIRED_CODE,
          message: "No assigned internal member",
        },
      }),
      call.variables,
      undefined,
      { client: new QueryClient(), meta: undefined },
    );
  });

  await waitFor(() => {
    expect(
      [...document.querySelectorAll('[data-slot="toast-title"]')].map(
        (node) => node.textContent,
      ),
    ).toContain(messages.errors.apiCodes.matterStewardHandoverRequired);
  });
});
