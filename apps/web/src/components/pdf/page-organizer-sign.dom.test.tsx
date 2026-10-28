import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { DOCUMENT_OCR_AVAILABILITY } from "@stll/api-contract/document-ocr-availability";

import type {
  PdfSignTarget,
  usePdfSignFlow,
} from "@/components/inspector/pdf-sign-action";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/" });

const { cleanup, fireEvent, render, screen } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { ActionCapabilitiesProvider } =
  await import("@/lib/organization/feature-access/capability-actions");
const { resolveActionCapabilities } =
  await import("@/lib/organization/feature-access/action-capabilities.logic");
const { PageOrganizerSignAction } = await import("./page-organizer-sign");
const { createPageOrganizerOperationOwner } =
  await import("./page-organizer-upload.logic");
const en = (await import("@/i18n/langs/en.json")).default;

afterEach(cleanup);
afterAll(async () => {
  await unregisterDomEnvironment();
});

const SIGN_LABEL = en.workspaces.files.desktopGate.signCurrent;
const ID = "90123344-5566-7788-9900-aabbccddeeff";
const openVersion = {
  entityId: ID,
  fieldId: "a0123344-5566-7788-9900-aabbccddeeff",
  propertyId: ID,
  workspaceId: ID,
} satisfies PdfSignTarget;
const savedVersion = {
  ...openVersion,
  fieldId: "b0123344-5566-7788-9900-aabbccddeeff",
} satisfies PdfSignTarget;

/**
 * The sign flow with stella desktop ready: `start` places the stamp on the
 * target it is given, `startWith` on whatever its preparation resolves. Each
 * placement is recorded as the version it signs, and revealing the viewer
 * for it as such.
 */
const readyFlow = (events: string[], pending: Promise<void>[]) =>
  ({
    label: SIGN_LABEL,
    actionLabel: SIGN_LABEL,
    status: { type: "ready" },
    setUp: () => undefined,
    isConnecting: false,
    isSigning: false,
    start: (target, reveal) => {
      events.push(`sign ${target.fieldId}`);
      reveal?.();
    },
    startWith: (prepare) => {
      pending.push(
        (async () => {
          const target = await prepare();
          if (target !== null) {
            events.push(`sign ${target.fieldId}`);
          }
        })(),
      );
    },
    requiredDialog: {
      action: "sign-pdf",
      onClose: () => undefined,
      onConnect: () => undefined,
      required: null,
    },
  }) satisfies ReturnType<typeof usePdfSignFlow>;

type MountOptions = {
  isDirty: boolean;
  /** What saving resolves: the new version, or `null` when the save failed. */
  saved: PdfSignTarget | null;
};

const mount = ({ isDirty, saved }: MountOptions) => {
  const operationOwner = createPageOrganizerOperationOwner();
  const events: string[] = [];
  const pending: Promise<void>[] = [];
  render(
    <QueryClientProvider client={new QueryClient()}>
      <IntlProvider locale="en" messages={en} timeZone="UTC">
        <ActionCapabilitiesProvider
          value={resolveActionCapabilities({
            role: "member",
            ai: false,
            deepl: false,
            ocr: DOCUMENT_OCR_AVAILABILITY.unconfigured,
            desktop: "current",
            settings: undefined,
          })}
        >
          <PageOrganizerSignAction
            closeEditor={() => {
              events.push("close editor");
            }}
            disabled={false}
            isDirty={isDirty}
            isOperationLive={operationOwner.isLive}
            operation={operationOwner.operation}
            saveVersion={async () => {
              events.push("save");
              return await Promise.resolve(saved);
            }}
            sign={{ flow: readyFlow(events, pending), target: openVersion }}
          />
        </ActionCapabilitiesProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );
  return { events, operationOwner, pending };
};

test("with unsaved page edits, signing saves a version first and signs that version", async () => {
  const { events, pending } = mount({ isDirty: true, saved: savedVersion });

  fireEvent.click(screen.getByRole("button", { name: SIGN_LABEL }));
  await Promise.all(pending);

  expect(events).toEqual(["save", `sign ${savedVersion.fieldId}`]);
});

test("with no page edits, signing places the stamp on the open version in the viewer", () => {
  const { events } = mount({ isDirty: false, saved: savedVersion });

  fireEvent.click(screen.getByRole("button", { name: SIGN_LABEL }));

  expect(events).toEqual([`sign ${openVersion.fieldId}`, "close editor"]);
});

test("a save that does not produce a version signs nothing", async () => {
  const { events, pending } = mount({ isDirty: true, saved: null });

  fireEvent.click(screen.getByRole("button", { name: SIGN_LABEL }));
  await Promise.all(pending);

  expect(events).toEqual(["save"]);
});

test("a dismissed organizer cannot hand a completed save to signing", async () => {
  const { events, operationOwner, pending } = mount({
    isDirty: true,
    saved: savedVersion,
  });

  fireEvent.click(screen.getByRole("button", { name: SIGN_LABEL }));
  operationOwner.revoke();
  await Promise.all(pending);

  expect(events).toEqual(["save"]);
});
