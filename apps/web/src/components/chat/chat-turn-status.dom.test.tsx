import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000" });
const { cleanup, render } = await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { ChatTurnStatus } = await import("@/components/chat/chat-turn-status");
const { ChatTurnDuration } =
  await import("@/components/chat/chat-turn-duration");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const messages = (await import("@/i18n/langs/en.json")).default;

afterEach(cleanup);
afterAll(async () => unregisterDomEnvironment());

const timing = {
  status: "running",
  durationMs: 0,
  elapsedMs: 0,
  startedAt: "2026-01-01T00:00:00.000Z",
  observedAt: "2026-01-01T00:00:00.000Z",
} as const;

const View = ({
  state,
  phase,
}: {
  state: "submitted" | "streaming" | "ready" | "error";
  phase: Parameters<typeof ChatTurnStatus>[0]["turn"]["phase"];
}) => (
  <IntlProvider locale="en" messages={messages} timeZone="UTC">
    <FormattingProvider locale="en" timeZone="UTC">
      <div data-turn>
        <ChatTurnStatus turn={{ state, phase, timing }} />
        <ChatTurnDuration
          timing={
            state === "ready"
              ? { status: "finished", durationMs: 5000 }
              : timing
          }
        />
      </div>
    </FormattingProvider>
  </IntlProvider>
);

test("owns one live indicator through every phase and yields to the summary", () => {
  const view = render(<View state="submitted" phase={{ type: "thinking" }} />);
  for (const phase of [
    { type: "thinking" },
    { type: "using-tool", label: "Integrations" },
    { type: "analyzing-sources" },
    { type: "writing" },
    { type: "waiting-for-approval" },
  ] as const) {
    view.rerender(<View state="streaming" phase={phase} />);
    expect(
      view.container.querySelectorAll("[data-turn-live-status]"),
    ).toHaveLength(1);
    expect(
      view.container.querySelectorAll('[data-turn] [data-slot="loader"]'),
    ).toHaveLength(1);
    expect(view.container.textContent).not.toContain("Worked for");
  }
  view.rerender(<View state="ready" phase={null} />);
  expect(view.container.querySelector("[data-turn-live-status]")).toBeNull();
  expect(view.container.textContent).toContain("Worked for 5s");
  view.rerender(<View state="error" phase={null} />);
  expect(view.container.querySelector("[data-turn-live-status]")).toBeNull();
});
