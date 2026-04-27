import { describe, expect, test } from "bun:test";

import type { Document } from "../types/document";
import { AutoSaveManager } from "./AutoSaveManager";

describe("AutoSaveManager localStorage policy", () => {
  test("stays disabled unless localStorage autosave is explicitly allowed", () => {
    const manager = new AutoSaveManager({ allowLocalStorage: false });

    manager.enable();

    expect(manager.getSnapshot().isEnabled).toBe(false);
  });

  test("does not persist changes before enable is called", async () => {
    installLocalStorageMock();
    const storageKey = "folio-autosave-disabled-test";
    localStorage.removeItem(storageKey);

    const manager = new AutoSaveManager({
      allowLocalStorage: true,
      storageKey,
      debounceDelay: 0,
    });
    const document: Document = { package: { document: { content: [] } } };

    manager.onDocumentChanged(document);
    await Bun.sleep(10);

    expect(manager.getSnapshot().isEnabled).toBe(false);
    expect(localStorage.getItem(storageKey)).toBeNull();
    localStorage.removeItem(storageKey);
  });
});

function installLocalStorageMock(): void {
  const items = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return items.size;
    },
    clear: () => {
      items.clear();
    },
    getItem: (key: string) => items.get(key) ?? null,
    key: (index: number) => Array.from(items.keys()).at(index) ?? null,
    removeItem: (key: string) => {
      items.delete(key);
    },
    setItem: (key: string, value: string) => {
      items.set(key, value);
    },
  };

  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
  });
}
