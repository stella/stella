import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient } from "@tanstack/react-query";
import { panic } from "better-result";
import { afterAll, afterEach, expect, test } from "bun:test";

GlobalRegistrator.register({ url: "http://localhost:3000/document" });

const { act, cleanup, fireEvent, render, renderHook } =
  await import("@testing-library/react");
const { renderToString } = await import("react-dom/server");
const { hydrateRoot } = await import("react-dom/client");
const { browserStateStorage, browserStorage } =
  await import("@/lib/account/browser-storage");
const { installUserScopedStorage } =
  await import("@/lib/account/install-user-scoped-storage");
const { releaseUserStorage, userStorageKey } =
  await import("@/lib/account/user-scoped-storage");
const { rootKeys } = await import("@/lib/auth-queries");
const { DOCX_OUTLINE_DEPTH, DOCX_OUTLINE_DEPTH_STORAGE_KEY } =
  await import("./docx-outline-depth.logic");
const { useDocxOutlineDepth } = await import("./use-docx-outline-depth");

const DEPTH_THREE_LABEL = "Levels 1–3";
const DEPTH_ALL_LABEL = "All levels";

const localArea = () =>
  browserStorage("local") ?? panic("Test requires local browser storage");

afterEach(() => {
  cleanup();
  releaseUserStorage();
  localArea().clear();
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const DepthChoice = () => {
  const { depth, setDepth } = useDocxOutlineDepth();
  return (
    <div>
      <output>{depth}</output>
      <button onClick={() => setDepth(DOCX_OUTLINE_DEPTH.three)} type="button">
        {DEPTH_THREE_LABEL}
      </button>
      <button onClick={() => setDepth(DOCX_OUTLINE_DEPTH.all)} type="button">
        {DEPTH_ALL_LABEL}
      </button>
    </div>
  );
};

test("server markup uses the default while the client restores the saved depth", async () => {
  const key = userStorageKey(DOCX_OUTLINE_DEPTH_STORAGE_KEY);
  const markup = renderToString(<DepthChoice />);
  expect(markup).toContain(String(DOCX_OUTLINE_DEPTH.two));
  localArea().setItem(key, DOCX_OUTLINE_DEPTH.all);

  const container = document.createElement("div");
  // safe-html: renderToString output from DepthChoice's fixed output and buttons.
  container.innerHTML = markup;
  document.body.append(container);
  const recoverableErrors: unknown[] = [];
  const root = hydrateRoot(container, <DepthChoice />, {
    onRecoverableError: (error) => {
      recoverableErrors.push(error);
    },
  });
  try {
    await act(async () => {
      await Promise.resolve();
    });
    expect(recoverableErrors).toEqual([]);
    expect(container.querySelector("output")?.textContent).toBe(
      DOCX_OUTLINE_DEPTH.all,
    );
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

test("a chosen outline depth survives a remount", () => {
  const reader = render(<DepthChoice />);
  fireEvent.click(reader.getByRole("button", { name: DEPTH_ALL_LABEL }));
  expect(
    localArea().getItem(userStorageKey(DOCX_OUTLINE_DEPTH_STORAGE_KEY)),
  ).toBe(DOCX_OUTLINE_DEPTH.all);

  reader.unmount();
  const remounted = render(<DepthChoice />);
  expect(remounted.getByRole("status").textContent).toBe(
    DOCX_OUTLINE_DEPTH.all,
  );
  fireEvent.click(remounted.getByRole("button", { name: DEPTH_THREE_LABEL }));
  expect(remounted.getByRole("status").textContent).toBe(
    String(DOCX_OUTLINE_DEPTH.three),
  );
});

test("invalid stored values default and stale setters cannot cross account owners", async () => {
  const visitorKey = userStorageKey(DOCX_OUTLINE_DEPTH_STORAGE_KEY);
  localArea().setItem(visitorKey, "unexpected");
  const client = new QueryClient();
  const uninstall = installUserScopedStorage(client);
  const { result } = renderHook(() => useDocxOutlineDepth());
  expect(result.current.depth).toBe(DOCX_OUTLINE_DEPTH.two);
  act(() => result.current.setDepth(DOCX_OUTLINE_DEPTH.all));

  await act(() =>
    client.setQueryData(rootKeys.session, { user: { id: "account-a" } }),
  );
  expect(result.current.depth).toBe(DOCX_OUTLINE_DEPTH.two);
  act(() => result.current.setDepth(DOCX_OUTLINE_DEPTH.three));
  const staleSetDepth = result.current.setDepth;
  const accountAKey = userStorageKey(DOCX_OUTLINE_DEPTH_STORAGE_KEY);

  await act(() =>
    client.setQueryData(rootKeys.session, { user: { id: "account-b" } }),
  );
  expect(result.current.depth).toBe(DOCX_OUTLINE_DEPTH.two);
  const accountBKey = userStorageKey(DOCX_OUTLINE_DEPTH_STORAGE_KEY);
  act(() => staleSetDepth(DOCX_OUTLINE_DEPTH.all));
  expect(result.current.depth).toBe(DOCX_OUTLINE_DEPTH.two);
  expect(browserStateStorage("local").getItem(accountBKey)).toBeNull();

  act(() => result.current.setDepth(DOCX_OUTLINE_DEPTH.all));
  expect(browserStateStorage("local").getItem(accountBKey)).toBe(
    DOCX_OUTLINE_DEPTH.all,
  );
  await act(() =>
    client.setQueryData(rootKeys.session, { user: { id: "account-a" } }),
  );
  expect(result.current.depth).toBe(DOCX_OUTLINE_DEPTH.three);

  expect(browserStateStorage("local").getItem(accountAKey)).toBe("3");
  expect(browserStateStorage("local").getItem(accountBKey)).toBe("all");
  uninstall();
  client.clear();
});
