import { beforeEach, describe, expect, mock, test } from "bun:test";

const invokeMock = mock();
const emitMock = mock(async () => undefined);

await mock.module("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
// The module registry is shared across test files, so the replacement has to
// carry every export the event module is imported for, not only `emit`.
await mock.module("@tauri-apps/api/event", () => ({
  emit: emitMock,
  listen: mock(async () => () => undefined),
}));

const store = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => store.get(key) ?? null,
    removeItem: (key: string) => {
      store.delete(key);
    },
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
  },
});

const { setPreferredLanguage, synchronizeDesktopLanguage } =
  await import("../src/i18n/index");

const STORAGE_KEY = "stella-desktop-language";

beforeEach(() => {
  store.clear();
  invokeMock.mockReset();
  emitMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
  emitMock.mockResolvedValue(undefined);
});

describe("setPreferredLanguage", () => {
  test("hands the choice to the backend, not only to this window", async () => {
    await setPreferredLanguage("cs");

    expect(invokeMock).toHaveBeenCalledWith("set_desktop_language", {
      language: "cs",
    });
    expect(store.get(STORAGE_KEY)).toBe("cs");
    expect(emitMock).toHaveBeenCalledTimes(1);
  });

  test("propagates a backend that refused the change", async () => {
    invokeMock.mockRejectedValue(new Error("language unavailable"));

    // bun-types declares `.rejects.toThrow` as void, so awaiting it trips
    // type-aware lint; capture the rejection explicitly instead.
    const rejection: unknown = await setPreferredLanguage("ar").then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).toBeInstanceOf(Error);
    expect(
      rejection instanceof Error ? rejection.message : String(rejection),
    ).toBe("language unavailable");
    // The event is what re-renders the windows; a backend that did not switch
    // must not leave them claiming it did, nor leave the refused choice in
    // storage for the next window to pick up.
    expect(emitMock).not.toHaveBeenCalled();
    expect(store.has(STORAGE_KEY)).toBe(false);
  });
});

describe("synchronizeDesktopLanguage", () => {
  test("pushes a stored choice down to a backend that predates it", async () => {
    store.set(STORAGE_KEY, "pl");

    expect(await synchronizeDesktopLanguage()).toBe("pl");

    expect(invokeMock).toHaveBeenCalledWith("set_desktop_language", {
      language: "pl",
    });
  });

  test("adopts the backend's locale when nothing is stored", async () => {
    invokeMock.mockResolvedValue("pt-BR");

    expect(await synchronizeDesktopLanguage()).toBe("pt-BR");

    expect(invokeMock).toHaveBeenCalledWith("get_desktop_language");
    expect(store.get(STORAGE_KEY)).toBe("pt-BR");
  });

  test("ignores a backend locale the windows do not ship", async () => {
    invokeMock.mockResolvedValue("kl-GL");

    const language = await synchronizeDesktopLanguage();

    expect(language).not.toBe("kl-GL");
    expect(store.get(STORAGE_KEY)).toBe(language);
  });
});
