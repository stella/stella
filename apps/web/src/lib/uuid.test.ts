import { describe, expect, spyOn, test } from "bun:test";

import { Temporal } from "@stll/time";

import {
  createEphemeralId,
  createRandomUuid,
  createRandomValue,
  createUuid,
} from "./uuid";

describe("web-owned UUID generation", () => {
  test("creates ephemeral markers without the secure-context randomUUID API", () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    const browserCrypto = globalThis.crypto;
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: {
        getRandomValues: browserCrypto.getRandomValues.bind(browserCrypto),
      },
    });
    try {
      const values = Array.from({ length: 100 }, createEphemeralId);
      expect(new Set(values).size).toBe(values.length);
      for (const value of values) {
        expect(value).toMatch(/^[0-9a-f]{32}$/u);
      }
    } finally {
      if (descriptor === undefined) {
        Reflect.deleteProperty(globalThis, "crypto");
      } else {
        Object.defineProperty(globalThis, "crypto", descriptor);
      }
    }
  });

  test("keeps ephemeral markers unique when cryptography is unavailable or blocked", () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    const blocked = new Error("Browser cryptography blocked");
    const now = spyOn(Temporal.Now, "instant").mockReturnValue(
      Temporal.Instant.fromEpochMilliseconds(1234),
    );
    const random = spyOn(Math, "random").mockReturnValue(0);
    const values: string[] = [];
    try {
      for (const crypto of [
        undefined,
        {},
        {
          getRandomValues: () => {
            throw blocked;
          },
        },
      ]) {
        Object.defineProperty(globalThis, "crypto", {
          configurable: true,
          value: crypto,
        });
        for (let index = 0; index < 100; index += 1) {
          const value = createEphemeralId();
          expect(value).toStartWith("ephemeral-");
          values.push(value);
        }
      }
      expect(new Set(values).size).toBe(values.length);
      expect(createRandomValue).toThrow(blocked);
    } finally {
      now.mockRestore();
      random.mockRestore();
      if (descriptor === undefined) {
        Reflect.deleteProperty(globalThis, "crypto");
      } else {
        Object.defineProperty(globalThis, "crypto", descriptor);
      }
    }
  });

  test("creates unique random version 4 UUIDs for protocol nonces", () => {
    const values = Array.from({ length: 100 }, createRandomUuid);
    expect(new Set(values).size).toBe(values.length);
    for (const value of values) {
      expect(value).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      );
    }
  });
  test("creates unique version 7 UUIDs", () => {
    const values = Array.from({ length: 100 }, createUuid);

    expect(new Set(values).size).toBe(values.length);
    for (const value of values) {
      expect(value).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      );
      expect(value.at(14)).toBe("7");
    }
  });

  test("creates unique full-entropy hexadecimal values", () => {
    const values = Array.from({ length: 100 }, createRandomValue);

    expect(new Set(values).size).toBe(values.length);
    for (const value of values) {
      expect(value).toHaveLength(32);
      expect(value).toMatch(/^[0-9a-f]+$/u);
    }
  });
});
