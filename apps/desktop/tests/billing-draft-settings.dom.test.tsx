import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic } from "better-result";
import { afterAll, afterEach, expect, mock, test } from "bun:test";

GlobalRegistrator.register({ url: "http://localhost/" });

// Other test files share Bun's module registry and the event SDK imports core.
const actualCore = { ...(await import("@tauri-apps/api/core")) };
const pending: ReturnType<typeof Promise.withResolvers<unknown>>[] = [];
await mock.module("@tauri-apps/api/core", () => ({
  ...actualCore,
  invoke: async (command: string) => {
    if (command === "desktop_report_error") {
      return undefined;
    }
    if (command !== "billing_draft_get_settings") {
      return panic("Unexpected native command", command);
    }
    const request = Promise.withResolvers<unknown>();
    pending.push(request);
    return await request.promise;
  },
}));

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
  pending.length = 0;
});
afterAll(async () => {
  mock.restore();
  await GlobalRegistrator.unregister();
});

test("the native command mock preserves exports required by the event SDK", async () => {
  const mockedCore = await import("@tauri-apps/api/core");
  expect(Object.keys(mockedCore).toSorted()).toEqual(
    Object.keys(actualCore).toSorted(),
  );
  expect(mockedCore.transformCallback).toBe(actualCore.transformCallback);
  expect(sdkEvent.listen).toBeFunction();
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
