import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic } from "better-result";
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";

import requestFixture from "../fixtures/billing-draft-request.json";

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

const { act, cleanup, render, fireEvent, waitFor } =
  await import("@testing-library/react");
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
  scopeKey: "settings-test",
  revision: null,
  organizationMode: "enabled",
  consent: "granted",
  preference,
});

afterEach(() => {
  cleanup();
  clearMocks();
  pending.length = 0;
  localStorage.clear();
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
  expect(view.getByRole("status").textContent).toBe('{"type":"failed"}');
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

test("withdrawal blocks transport immediately and a failed save or preference refresh cannot re-grant it", async () => {
  const revoked = Promise.withResolvers<unknown>();
  let drafts = 0;
  mockIPC((command, args) => {
    switch (command) {
      case "billing_draft_get_settings":
      case "billing_draft_set_preference":
        return settingsResponse(null);
      case "billing_draft_set_consent":
        return args && "consent" in args && args["consent"] === "revoked"
          ? revoked.promise
          : settingsResponse(null);
      case "billing_draft_create_confirmed":
        drafts += 1;
        return {};
      case "desktop_report_error":
        return undefined;
      default:
        return panic("Unexpected consent command", command);
    }
  });
  const request =
    requestFixture.requests.at(0) ?? panic("Missing drafting fixture");
  const Probe = () => {
    const control = useBillingDraftSettings(true);
    return (
      <>
        <output>{JSON.stringify(control.settings)}</output>
        <button
          type="button"
          onClick={() => {
            void control.setConsent("revoked");
          }}
        >
          Withdraw
        </button>
        <button
          type="button"
          onClick={() => {
            void control.setPreference("Shorter");
          }}
        >
          Preference
        </button>
        <button
          type="button"
          onClick={() => {
            void control.setConsent("granted");
          }}
        >
          Grant
        </button>
        <button
          type="button"
          onClick={() => {
            void control.consent.request(request);
          }}
        >
          Draft
        </button>
      </>
    );
  };
  const view = render(<Probe />);
  await waitFor(() =>
    expect(view.getByRole("status").textContent).toContain('"granted"'),
  );
  fireEvent.click(view.getByRole("button", { name: "Withdraw" }));
  fireEvent.click(view.getByRole("button", { name: "Draft" }));
  expect(drafts).toBe(0);
  expect(view.getByRole("status").textContent).toContain(
    '"pending-withdrawal"',
  );
  await act(async () => {
    revoked.reject("consent save failed");
    await Promise.resolve();
  });
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Preference" }));
    await Promise.resolve();
  });
  fireEvent.click(view.getByRole("button", { name: "Draft" }));
  expect(drafts).toBe(0);
  expect(view.getByRole("status").textContent).toContain(
    '"pending-withdrawal"',
  );
  fireEvent.click(view.getByRole("button", { name: "Grant" }));
  await waitFor(() =>
    expect(view.getByRole("status").textContent).toContain('"granted"'),
  );
  fireEvent.click(view.getByRole("button", { name: "Draft" }));
  expect(drafts).toBe(1);
});

test("a failed withdrawal survives restart, blocks startup drafting, and remains retryable in settings", async () => {
  const { BillingDraftSettingsSection } =
    await import("../src/activity/ActivityBillingDrafts");
  const { DesktopIntlProvider, defaultMessages: messages } =
    await import("../src/i18n");
  let serverConsent = "granted";
  let revision = "1";
  let saves = 0;
  let drafts = 0;
  let failRead = false;
  mockIPC((command, args) => {
    const response = () => ({
      scopeKey: "settings-test",
      revision,
      organizationMode: "enabled",
      consent: serverConsent,
      preference: null,
    });
    switch (command) {
      case "billing_draft_get_settings":
        if (failRead) {
          failRead = false;
          return Promise.reject(new Error("offline startup"));
        }
        return response();
      case "billing_draft_set_consent":
        saves += 1;
        if (saves <= 2) {
          return Promise.reject(new Error("offline"));
        }
        expect(args).toMatchObject({ consent: "revoked", revision });
        serverConsent = "revoked";
        revision = "2";
        return response();
      case "billing_draft_create_confirmed":
        drafts += 1;
        return {};
      case "desktop_report_error":
        return undefined;
      default:
        return panic("Unexpected restart command", command);
    }
  });
  const request =
    requestFixture.requests.at(0) ?? panic("Missing drafting fixture");
  const Probe = () => {
    const control = useBillingDraftSettings(true);
    return (
      <>
        <BillingDraftSettingsSection control={control} />
        <output>{control.consent.getSnapshot()}</output>
        <button
          type="button"
          onClick={() => {
            void control.consent.request(request);
          }}
        >
          Draft
        </button>
      </>
    );
  };
  const mount = () =>
    render(
      <DesktopIntlProvider language="en" messages={messages}>
        <Probe />
      </DesktopIntlProvider>,
    );
  const first = mount();
  await waitFor(() =>
    expect(first.getByRole("status").textContent).toBe("granted"),
  );
  fireEvent.click(
    first.getByRole("button", { name: messages.activity.aiSettingsRevoke }),
  );
  await waitFor(() =>
    expect(first.getByRole("alert").textContent).toBe(
      messages.activity.aiSettingsFailed,
    ),
  );
  expect(first.getByRole("status").textContent).toBe("pending-withdrawal");
  expect(serverConsent).toBe("granted");
  first.unmount();
  failRead = true;
  const restarted = mount();
  fireEvent.click(restarted.getByRole("button", { name: "Draft" }));
  await waitFor(() =>
    expect(
      restarted.getByRole("button", { name: messages.activity.retry }),
    ).toBeTruthy(),
  );
  expect(drafts).toBe(0);
  fireEvent.click(
    restarted.getByRole("button", { name: messages.activity.retry }),
  );
  await waitFor(() => expect(saves).toBe(2));
  expect(restarted.getByRole("status").textContent).toBe("pending-withdrawal");
  fireEvent.click(restarted.getByRole("button", { name: "Draft" }));
  expect(drafts).toBe(0);
  fireEvent.click(
    restarted.getByRole("button", { name: messages.activity.aiSettingsRevoke }),
  );
  await waitFor(() =>
    expect(restarted.getByRole("status").textContent).toBe("revoked"),
  );
  expect(saves).toBe(3);
  expect(serverConsent).toBe("revoked");
  expect(
    localStorage.getItem("billing-draft-withdrawal:settings-test"),
  ).toBeNull();
});

test("a delayed grant acknowledgement cannot overtake a newer withdrawal and saves use fresh CAS tokens", async () => {
  let serverConsent = "revoked";
  let revision = "1";
  let drafts = 0;
  const saves: {
    value: string;
    deferred: ReturnType<typeof Promise.withResolvers<unknown>>;
  }[] = [];
  const response = () => ({
    scopeKey: "settings-test",
    revision,
    organizationMode: "enabled",
    consent: serverConsent,
    preference: null,
  });
  mockIPC((command, args) => {
    switch (command) {
      case "billing_draft_get_settings":
        return response();
      case "billing_draft_set_consent": {
        expect(args).toMatchObject({ revision });
        const value = args && "consent" in args ? args["consent"] : undefined;
        if (typeof value !== "string") {
          return panic("Missing consent intent");
        }
        const deferred = Promise.withResolvers<unknown>();
        saves.push({ value, deferred });
        return deferred.promise;
      }
      case "billing_draft_create_confirmed":
        drafts += 1;
        return {};
      case "desktop_report_error":
        return undefined;
      default:
        return panic("Unexpected ordering command", command);
    }
  });
  const request =
    requestFixture.requests.at(0) ?? panic("Missing drafting fixture");
  const Probe = () => {
    const control = useBillingDraftSettings(true);
    return (
      <>
        <output>{control.consent.getSnapshot()}</output>
        <button
          type="button"
          onClick={() => {
            void control.setConsent("granted");
          }}
        >
          Grant
        </button>
        <button
          type="button"
          onClick={() => {
            void control.setConsent("revoked");
          }}
        >
          Withdraw
        </button>
        <button
          type="button"
          onClick={() => {
            void control.consent.request(request);
          }}
        >
          Draft
        </button>
      </>
    );
  };
  const view = render(<Probe />);
  await waitFor(() =>
    expect(view.getByRole("status").textContent).toBe("revoked"),
  );
  fireEvent.click(view.getByRole("button", { name: "Grant" }));
  await waitFor(() => expect(saves).toHaveLength(1));
  fireEvent.click(view.getByRole("button", { name: "Withdraw" }));
  expect(saves).toHaveLength(1);
  await act(async () => {
    serverConsent = "granted";
    revision = "2";
    saves.at(0)?.deferred.resolve(response());
  });
  await waitFor(() => expect(saves).toHaveLength(2));
  expect(view.getByRole("status").textContent).toBe("pending-withdrawal");
  fireEvent.click(view.getByRole("button", { name: "Draft" }));
  expect(drafts).toBe(0);
  expect(saves.map(({ value }) => value)).toEqual(["granted", "revoked"]);
  await act(async () => {
    serverConsent = "revoked";
    revision = "3";
    saves.at(1)?.deferred.resolve(response());
  });
  expect(view.getByRole("status").textContent).toBe("revoked");
});
