import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/" });

const router = await import("@tanstack/react-router");
await mock.module("@tanstack/react-router", () => ({
  ...router,
  useRouter: () => ({ state: { matches: [] } }),
}));

const { act } = await import("react");
const { cleanup, fireEvent, render, screen } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const messages = (await import("@/i18n/langs/en.json")).default;
const { AuthenticatedUserProvider } =
  await import("@/lib/authenticated-user-context");
const { aiAvailabilityOptions } =
  await import("@/lib/organization/ai-config-queries");
const { roleOptions } = await import("@/lib/auth-queries");
const { TranscribeRecording } = await import("./transcribe-recording");

const WORKSPACE_ID = "33333333-3333-4333-8333-333333333333";
const ENTITY_ID = "22222222-2222-4222-8222-222222222222";
const FIELD_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "44444444-4444-4444-8444-444444444444";
const OUTPUT_ID = "55555555-5555-4555-8555-555555555555";
const ORGANIZATION_ID = "66666666-6666-4666-8666-666666666666";

const run = (overrides: Record<string, unknown>) => ({
  id: RUN_ID,
  entityId: ENTITY_ID,
  status: "transcribing",
  errorCode: null,
  durationMs: 60_000,
  transcribedMs: 15_000,
  outputEntityId: null,
  outputFieldId: null,
  outputFileName: null,
  createdAt: "2026-11-26T10:00:00.000Z",
  finishedAt: null,
  ...overrides,
});

const originalFetch = globalThis.fetch;
let starts: unknown[] = [];
let startAnswer: () => Response;
let runAnswer: () => Response;
let current: ReturnType<typeof run>;
beforeEach(() => {
  starts = [];
  startAnswer = () => Response.json({ runId: RUN_ID });
  current = run({});
  runAnswer = () => Response.json({ run: current });
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith("/recording-transcriptions/runs")) {
        if (typeof init?.body === "string") {
          starts.push(JSON.parse(init.body));
        }
        return startAnswer();
      }
      if (url.endsWith(`/recording-transcriptions/runs/${RUN_ID}`)) {
        return runAnswer();
      }
      throw new TypeError(`Unexpected transport: ${url}`);
    },
    { preconnect: originalFetch.preconnect },
  );
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await act(async () => {
    cleanup();
  });
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

const show = (
  openDocument = mock(async () => ({ type: "opened" as const })),
) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(
    aiAvailabilityOptions({ organizationId: ORGANIZATION_ID }).queryKey,
    {
      available: true,
      unavailableReason: null,
      providerConfiguration: "allowed",
      deferredServiceTierAvailable: false,
      instanceProvisioned: false,
      mockAnswers: false,
      orgConfigured: true,
    },
  );
  queryClient.setQueryData(roleOptions.queryKey, "admin");
  render(
    <QueryClientProvider client={queryClient}>
      <AuthenticatedUserProvider
        user={{
          activeOrganizationId: ORGANIZATION_ID,
          email: "member@example.test",
          id: "user",
          image: null,
          name: "Member",
          preferredName: null,
          timezoneId: "UTC",
          wordEditShortcut: null,
        }}
      >
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <TranscribeRecording
            entityId={ENTITY_ID}
            fieldId={FIELD_ID}
            openDocument={openDocument}
            workspaceId={WORKSPACE_ID}
          />
        </IntlProvider>
      </AuthenticatedUserProvider>
    </QueryClientProvider>,
  );
  return { openDocument, queryClient };
};

const transcribe = async () => {
  fireEvent.click(
    await screen.findByRole("button", {
      name: messages.inspector.transcribe.action,
    }),
  );
};

test("starts a transcription of the open recording and shows its progress", async () => {
  show();
  await transcribe();
  expect(await screen.findByText("Transcribing… 25%")).toBeDefined();
  expect(starts).toEqual([{ entityId: ENTITY_ID, fieldId: FIELD_ID }]);
});

test("a saved transcript opens beside the recording", async () => {
  current = run({
    status: "completed",
    transcribedMs: 60_000,
    outputEntityId: OUTPUT_ID,
    outputFieldId: FIELD_ID,
    outputFileName: "Hearing transcript.docx",
    finishedAt: "2026-11-26T10:01:00.000Z",
  });
  const { openDocument } = show();
  await transcribe();
  await screen.findByText("Transcript saved as Hearing transcript.docx");
  fireEvent.click(screen.getByRole("button", { name: "Open" }));
  expect(openDocument).toHaveBeenCalledWith(
    expect.objectContaining({
      entityId: OUTPUT_ID,
      fieldId: FIELD_ID,
      workspaceId: WORKSPACE_ID,
    }),
  );
});

test("a failed run says why and transcribes again on retry", async () => {
  current = run({
    status: "failed",
    errorCode: "no_speech",
    finishedAt: "2026-11-26T10:01:00.000Z",
  });
  show();
  await transcribe();
  await screen.findByText(messages.inspector.transcribe.failed.noSpeech);
  current = run({});
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByText("Transcribing… 25%");
  expect(starts).toHaveLength(2);
});

test("a refused start offers a retry", async () => {
  startAnswer = () =>
    Response.json(
      {
        code: "recording_transcription_in_progress",
        message: "This recording is already being transcribed",
      },
      { status: 409 },
    );
  show();
  await transcribe();
  expect(await screen.findByRole("alert")).toBeDefined();
  expect(screen.getByRole("button", { name: "Retry" })).toBeDefined();
});

test("a failed run read retries the read, not the start", async () => {
  runAnswer = () => Response.json({ message: "Forbidden" }, { status: 403 });
  show();
  await transcribe();
  await screen.findByRole("alert");
  runAnswer = () => Response.json({ run: current });
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByText("Transcribing… 25%");
  expect(starts).toHaveLength(1);
});
