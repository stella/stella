import { describe, expect, test } from "bun:test";

import {
  PERSISTED_UI_STATE_NAMES,
  PERSISTED_UI_STATE_PREFIXES,
  persistedUiStateFingerprint,
  resetPersistedUiState,
} from "@/lib/analytics/web-hang/persisted-ui-state";

const memoryStorage = (entries: [string, string][]): Storage => {
  const values = new Map(entries);
  return {
    get length() {
      return values.size;
    },
    key: (index) => [...values.keys()].at(index) ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
    clear: () => values.clear(),
  };
};

describe("persisted layout recovery", () => {
  test("resets every registered layout family while preserving other browser data", () => {
    const layoutKeys = PERSISTED_UI_STATE_PREFIXES.map(
      (prefix) => `${prefix}private-owner-id`,
    );
    const legacyKeys = [
      "stella:inspector-state",
      "stella:inspector-width",
      "stella:inspector-minimized",
    ];
    const storage = memoryStorage([
      ...layoutKeys.map((key): [string, string] => [key, "saved layout"]),
      ...legacyKeys.map((key): [string, string] => [key, "legacy layout"]),
      ["stella.chat.threadActiveSkill:u:owner", "saved skill"],
      ["stella:web-hang:tab", "marker"],
    ]);
    expect(layoutKeys.length).toBeGreaterThan(0);
    for (const key of layoutKeys) {
      expect(storage.getItem(key)).toBe("saved layout");
    }
    resetPersistedUiState(storage);
    for (const key of [...layoutKeys, ...legacyKeys]) {
      expect(storage.getItem(key)).toBeNull();
    }
    expect(storage.getItem("stella.chat.threadActiveSkill:u:owner")).toBe(
      "saved skill",
    );
    expect(storage.getItem("stella:web-hang:tab")).toBe("marker");
  });

  test("fingerprints contain canonical names and UTF-8 sizes without keys or values", () => {
    const storage = memoryStorage([
      ["stella:inspector-state:v1:private-org:u:private-user", "秘密"],
      ["stella:inspector-state:v1:other-org:u:other-user", "x"],
      ["sidebar_state", "true"],
      ["stella.chat.threadActiveSkill:u:private-user", "confidential"],
    ]);
    const fingerprint = persistedUiStateFingerprint(storage);
    expect(fingerprint).toEqual([
      { key: "stella:inspector-state:v1:", bytes: 7 },
    ]);
    const serialized = JSON.stringify(fingerprint);
    for (const secret of [
      "秘密",
      "private-org",
      "private-user",
      "other-org",
      "other-user",
      "confidential",
      "sidebar_state",
    ]) {
      expect(serialized).not.toContain(secret);
    }
    for (const { key } of fingerprint) {
      expect(PERSISTED_UI_STATE_NAMES).toContain(key);
    }
  });

  test("blocked storage yields an empty fingerprint and leaves boot usable", () => {
    const storage = memoryStorage([]);
    Object.defineProperty(storage, "length", {
      get: () => {
        throw new DOMException("Storage blocked", "SecurityError");
      },
    });
    expect(persistedUiStateFingerprint(storage)).toEqual([]);
    resetPersistedUiState(storage);
    expect(persistedUiStateFingerprint(null)).toEqual([]);
    resetPersistedUiState(null);
  });

  test("one failed removal does not prevent resetting the rest", () => {
    const storage = memoryStorage([
      ["stella:inspector-state", "saved layout"],
      ["stella:inspector-width", "620"],
      ["sidebar_state", "true"],
    ]);
    const remove = storage.removeItem;
    storage.removeItem = (key) => {
      if (key === "stella:inspector-state") {
        throw new DOMException("Storage blocked", "SecurityError");
      }
      remove(key);
    };
    resetPersistedUiState(storage);
    expect(storage.getItem("stella:inspector-width")).toBeNull();
    expect(storage.getItem("stella:inspector-state")).toBe("saved layout");
    expect(storage.getItem("sidebar_state")).toBe("true");
  });
});
