import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  browserStateStorage,
  browserStorage,
  deviceStorage,
  requireBrowserStorage,
} from "@/lib/account/browser-storage";
import {
  DEVICE_STORAGE_FAMILIES,
  USER_STORAGE_FAMILIES,
} from "@/lib/account/storage-families";
import {
  pruneUserStorage,
  userStorageKey,
} from "@/lib/account/user-scoped-storage";

const memoryStorage = (): Storage => {
  const entries = new Map<string, string>();
  return {
    get length() {
      return entries.size;
    },
    clear: () => entries.clear(),
    getItem: (key) => entries.get(key) ?? null,
    key: (index) => [...entries.keys()].at(index) ?? null,
    removeItem: (key) => {
      entries.delete(key);
    },
    setItem: (key, value) => {
      entries.set(key, value);
    },
  };
};

let previousWindow: PropertyDescriptor | undefined;

beforeEach(() => {
  previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: { localStorage: memoryStorage(), sessionStorage: memoryStorage() },
  });
});

afterEach(() => {
  if (previousWindow === undefined) {
    Reflect.deleteProperty(globalThis, "window");
    return;
  }
  Object.defineProperty(globalThis, "window", previousWindow);
});

describe("registered browser storage families", () => {
  test("every registered user and device family can persist and remove its entries", () => {
    for (const family of [
      ...USER_STORAGE_FAMILIES,
      ...DEVICE_STORAGE_FAMILIES,
    ]) {
      const key = `${family.prefix}fixture`;
      const area = browserStateStorage(family.area);
      area.setItem(key, "fixture value");
      expect(area.getItem(key)).toBe("fixture value");
      area.removeItem(key);
      expect(area.getItem(key)).toBeNull();
    }
    for (const family of DEVICE_STORAGE_FAMILIES) {
      const area = deviceStorage(family.area);
      area.setItem(family.prefix, "device value");
      expect(area.getItem(family.prefix)).toBe("device value");
    }
  });

  test("each scoped family derives keys for both visitors and signed-in accounts", () => {
    for (const family of USER_STORAGE_FAMILIES) {
      if (family.owner !== "scoped") {
        continue;
      }
      const visitorKey = userStorageKey(family.prefix, { kind: "visitor" });
      const accountKey = userStorageKey(family.prefix, {
        kind: "user",
        userId: "fixture-user",
      });
      expect(visitorKey).not.toBe(accountKey);
      const area = browserStateStorage(family.area);
      area.setItem(visitorKey, "visitor");
      area.setItem(accountKey, "account");
      expect(area.getItem(visitorKey)).toBe("visitor");
      expect(area.getItem(accountKey)).toBe("account");
    }
  });

  test("every scoped family follows its owner while every device family stays", () => {
    const account = { kind: "user", userId: "fixture-user" } as const;
    const visitor = { kind: "visitor" } as const;
    for (const family of USER_STORAGE_FAMILIES) {
      if (family.owner !== "scoped") {
        continue;
      }
      const area = browserStateStorage(family.area);
      area.setItem(userStorageKey(family.prefix, account), "account");
      area.setItem(userStorageKey(family.prefix, visitor), "visitor");
    }
    for (const family of DEVICE_STORAGE_FAMILIES) {
      deviceStorage(family.area).setItem(family.prefix, "device");
    }
    pruneUserStorage(
      { local: browserStorage("local"), session: browserStorage("session") },
      account,
      visitor,
    );
    for (const family of USER_STORAGE_FAMILIES) {
      if (family.owner !== "scoped") {
        continue;
      }
      const area = browserStateStorage(family.area);
      expect(area.getItem(userStorageKey(family.prefix, account))).toBeNull();
      expect(area.getItem(userStorageKey(family.prefix, visitor))).toBe(
        "visitor",
      );
    }
    for (const family of DEVICE_STORAGE_FAMILIES) {
      expect(deviceStorage(family.area).getItem(family.prefix)).toBe("device");
    }
  });

  test("an unregistered family is rejected before touching browser storage", () => {
    const key = "unregistered.fixture";
    for (const areaName of new Set(
      USER_STORAGE_FAMILIES.map(({ area }) => area),
    )) {
      const area = browserStateStorage(areaName);
      const message = `Unregistered ${areaName} storage family`;
      expect(() => area.setItem(key, "unexpected")).toThrow(message);
      expect(() => area.getItem(key)).toThrow(message);
      expect(() => area.removeItem(key)).toThrow(message);
      expect(browserStorage(areaName)?.length).toBe(0);
    }
    expect(() => userStorageKey(key)).toThrow(
      "Unregistered user storage family",
    );
  });

  test("a user family cannot be written as a device preference", () => {
    for (const family of USER_STORAGE_FAMILIES) {
      const area = deviceStorage(family.area);
      expect(() => area.setItem(family.prefix, "unexpected")).toThrow(
        `Unregistered ${family.area} storage family`,
      );
    }
  });

  test("blocked browser storage is treated as unavailable", () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        get localStorage() {
          throw new DOMException("Blocked site data", "SecurityError");
        },
        sessionStorage: {
          getItem: () => {
            throw new DOMException("Blocked site data", "SecurityError");
          },
          setItem: () => {
            throw new DOMException("Blocked site data", "SecurityError");
          },
          removeItem: () => {
            throw new DOMException("Blocked site data", "SecurityError");
          },
        },
      },
    });
    expect(browserStorage("local")).toBeNull();
    const local = deviceStorage("local");
    local.setItem("sidebar_state", "open");
    expect(local.getItem("sidebar_state")).toBeNull();
    local.removeItem("sidebar_state");
    const session = browserStateStorage("session");
    session.setItem("stella.storage-owner", "visitor");
    expect(session.getItem("stella.storage-owner")).toBeNull();
    session.removeItem("stella.storage-owner");
  });
});

describe("required registered persistence", () => {
  test("registered entries propagate storage failures to the caller", () => {
    const original = browserStorage("local");
    if (original === null) {
      throw new DOMException(
        "Test storage is unavailable",
        "InvalidStateError",
      );
    }
    const strict = requireBrowserStorage("local");
    strict.setItem("sidebar_state", "expanded");
    expect(strict.getItem("sidebar_state")).toBe("expanded");
    expect(() => strict.setItem("unregistered.fixture", "value")).toThrow(
      "Unregistered local storage family",
    );
    original.setItem = () => {
      throw new DOMException("Storage quota exceeded", "QuotaExceededError");
    };
    expect(() => strict.setItem("sidebar_state", "collapsed")).toThrow(
      "Storage quota exceeded",
    );
    expect(strict.getItem("sidebar_state")).toBe("expanded");
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {},
    });
    expect(() => requireBrowserStorage("local")).toThrow(
      "Browser storage is unavailable",
    );
  });
});
