import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient } from "@tanstack/react-query";
import { panic } from "better-result";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import { browserStorage } from "@/lib/account/browser-storage";
import { unregisterDomEnvironment } from "@/test-dom-environment";

const localArea = () =>
  browserStorage("local") ?? panic("Test requires local browser storage");
const sessionArea = () =>
  browserStorage("session") ?? panic("Test requires session browser storage");

GlobalRegistrator.register({ url: "http://localhost:3000/law" });

const { act, cleanup, fireEvent, render } =
  await import("@testing-library/react");
const { renderToString } = await import("react-dom/server");
const { useReaderProvisionMode } =
  await import("@/hooks/use-reader-provision-mode");
const { READER_PROVISION_MODE_STORAGE_KEY } =
  await import("@/components/legal-reader/reader-provision-mode.logic");
const { installUserScopedStorage } =
  await import("@/lib/account/install-user-scoped-storage");
const { releaseUserStorage, userStorageKey } =
  await import("@/lib/account/user-scoped-storage");
const { rootKeys } = await import("@/lib/auth-queries");

afterEach(() => {
  cleanup();
  releaseUserStorage();
  localArea().clear();
  sessionArea().clear();
});

afterAll(async () => {
  await unregisterDomEnvironment();
});

const Reader = ({ label }: { label: string }) => {
  const mode = useReaderProvisionMode();
  return (
    <button
      aria-label={label}
      aria-pressed={mode.expandProvisions}
      onClick={mode.toggle}
      type="button"
    >
      {mode.expandProvisions ? "expanded" : "collapsed"}
    </button>
  );
};

describe("remembered provision reading mode", () => {
  test("starts collapsed on the server and with no stored choice", () => {
    expect(renderToString(<Reader label="server" />)).toContain(
      'aria-pressed="false"',
    );
    const reader = render(<Reader label="reader" />);
    expect(reader.getByRole("button").getAttribute("aria-pressed")).toBe(
      "false",
    );
  });

  test("keeps server markup collapsed while the client restores a stored choice", () => {
    localArea().setItem(
      userStorageKey(READER_PROVISION_MODE_STORAGE_KEY),
      '"expanded"',
    );
    expect(renderToString(<Reader label="server" />)).toContain(
      'aria-pressed="false"',
    );
    const reader = render(<Reader label="reader" />);
    expect(reader.getByRole("button").getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  test("a choice is shared by mounted readers and survives a remount", () => {
    const readers = render(
      <>
        <Reader label="page" />
        <Reader label="inspector" />
      </>,
    );
    fireEvent.click(readers.getByRole("button", { name: "page" }));
    expect(
      readers
        .getByRole("button", { name: "inspector" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      localArea().getItem(userStorageKey(READER_PROVISION_MODE_STORAGE_KEY)),
    ).toBe('"expanded"');
    readers.unmount();
    const remounted = render(<Reader label="next decision" />);
    expect(remounted.getByRole("button").getAttribute("aria-pressed")).toBe(
      "true",
    );
    fireEvent.click(remounted.getByRole("button"));
    expect(
      localArea().getItem(userStorageKey(READER_PROVISION_MODE_STORAGE_KEY)),
    ).toBe('"collapsed"');
  });

  test("reads only valid stored modes and follows another tab's changes", () => {
    const key = userStorageKey(READER_PROVISION_MODE_STORAGE_KEY);
    localArea().setItem(key, '"unexpected"');
    const reader = render(<Reader label="reader" />);
    expect(reader.getByRole("button").getAttribute("aria-pressed")).toBe(
      "false",
    );
    act(() => {
      localArea().setItem(key, '"expanded"');
      window.dispatchEvent(
        new StorageEvent("storage", { key, storageArea: localArea() }),
      );
    });
    expect(reader.getByRole("button").getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  test("account changes use separate keys and keep the departing owner's choice for them", async () => {
    const client = new QueryClient();
    const uninstall = installUserScopedStorage(client);
    const reader = render(<Reader label="reader" />);
    fireEvent.click(reader.getByRole("button"));
    const visitorKey = userStorageKey(READER_PROVISION_MODE_STORAGE_KEY);
    await act(() =>
      client.setQueryData(rootKeys.session, { user: { id: "account-a" } }),
    );
    const accountAKey = userStorageKey(READER_PROVISION_MODE_STORAGE_KEY);
    expect(accountAKey).not.toBe(visitorKey);
    expect(localArea().getItem(visitorKey)).toBeNull();
    expect(reader.getByRole("button").getAttribute("aria-pressed")).toBe(
      "false",
    );
    fireEvent.click(reader.getByRole("button"));
    expect(localArea().getItem(accountAKey)).toBe('"expanded"');
    await act(() =>
      client.setQueryData(rootKeys.session, { user: { id: "account-b" } }),
    );
    expect(userStorageKey(READER_PROVISION_MODE_STORAGE_KEY)).not.toBe(
      accountAKey,
    );
    expect(localArea().getItem(accountAKey)).toBe('"expanded"');
    expect(reader.getByRole("button").getAttribute("aria-pressed")).toBe(
      "false",
    );
    uninstall();
    client.clear();
  });
});
