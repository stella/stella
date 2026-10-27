import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic } from "better-result";
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";

GlobalRegistrator.register({ url: "http://localhost/" });

const { clearMocks, mockIPC } = await import("@tauri-apps/api/mocks");
const pending: ReturnType<typeof Promise.withResolvers<unknown>>[] = [];
beforeEach(() => {
  mockIPC(async (command) => {
    if (command === "desktop_report_error") {
      return undefined;
    }
    if (command !== "billing_draft_get_settings") {
      return panic("Unexpected native command", command);
    }
    const request = Promise.withResolvers<unknown>();
    pending.push(request);
    return await request.promise;
  });
});

const sdkEvent = await import("@tauri-apps/api/event");

const { act, cleanup, render } = await import("@testing-library/react");
const { flushSync } = await import("react-dom");
const { useBillingDraftSettings } =
  await import("../src/activity/ActivityBillingDrafts");

const Settings = ({ enabled }: { enabled: boolean }) => {
  const { settings } = useBillingDraftSettings(enabled);
  return <output>{JSON.stringify(settings)}</output>;
};
const takeRequest = () =>
  pending.shift() ?? panic("Expected a settings request");
const settingsResponse = (preference: string | null) => ({
  organizationMode: "enabled",
  consent: "granted",
  preference,
});

afterEach(() => {
  cleanup();
  clearMocks();
  pending.length = 0;
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

test("the native transport can be replaced without replacing SDK modules", async () => {
  const { invoke } = await import("@tauri-apps/api/core");
  const settings = invoke("billing_draft_get_settings");
  takeRequest().resolve(settingsResponse("First transport"));
  expect(await settings).toEqual(settingsResponse("First transport"));
  clearMocks();
  mockIPC(() => "Next transport", { shouldMockEvents: true });
  expect(await invoke("next_fixture_command")).toBe("Next transport");
  const received: unknown[] = [];
  const unlisten = await sdkEvent.listen("next-fixture-event", (event) => {
    received.push(event.payload);
  });
  await sdkEvent.emit("next-fixture-event", { revision: 1 });
  expect(received).toEqual([{ revision: 1 }]);
  unlisten();
});

test("a settings validation continuation cannot restore a disabled account's response", async () => {
  const view = render(<Settings enabled />);
  const first = takeRequest();
  await act(async () => {
    first.resolve(settingsResponse("stale preference"));
    await first.promise;
    await Promise.resolve();
    flushSync(() => view.rerender(<Settings enabled={false} />));
    flushSync(() => view.rerender(<Settings enabled />));
  });
  expect(view.getByRole("status").textContent).not.toContain(
    "stale preference",
  );
  expect(view.getByRole("status").textContent).toContain('"loading"');
  const fresh = takeRequest();
  await act(async () => fresh.resolve(settingsResponse("fresh preference")));
  expect(view.getByRole("status").textContent).toBe(
    JSON.stringify({
      type: "ready",
      consent: "granted",
      preference: "fresh preference",
    }),
  );
});

test("settings schema rejects invalid responses and keeps disabled organizations unavailable", async () => {
  const view = render(<Settings enabled />);
  const invalid = takeRequest();
  await act(async () =>
    invalid.resolve({ ...settingsResponse(null), consent: "unknown" }),
  );
  expect(view.getByRole("status").textContent).toBe('{"type":"unavailable"}');
  view.rerender(<Settings enabled={false} />);
  view.rerender(<Settings enabled />);
  const disabled = takeRequest();
  await act(async () =>
    disabled.resolve({
      ...settingsResponse(null),
      organizationMode: "disabled",
    }),
  );
  expect(view.getByRole("status").textContent).toBe('{"type":"unavailable"}');
});
