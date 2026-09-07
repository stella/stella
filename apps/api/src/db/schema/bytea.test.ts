import { describe, expect, test } from "bun:test";

import { businessRegistryCredentials } from "@/api/db/schema";

describe("binary database driver decoding", () => {
  test("preserves every byte through Buffer, Uint8Array and hexadecimal driver representations", () => {
    const values = [
      Buffer.alloc(0),
      Buffer.from(Array.from({ length: 256 }, (_, byte) => byte)),
    ];
    for (const bytes of values) {
      const driverValues = [
        bytes,
        new Uint8Array(bytes),
        bytes.toString("hex"),
        `\\x${bytes.toString("hex")}`,
      ];
      for (const driverValue of driverValues) {
        const decoded =
          businessRegistryCredentials.ciphertext.mapFromDriverValue(
            driverValue,
          );
        expect(Buffer.isBuffer(decoded)).toBe(true);
        expect(decoded).toEqual(bytes);
      }
    }
  });

  test("decodes only a Uint8Array view's bytes rather than its entire backing allocation", () => {
    const allocation = new Uint8Array([255, 0, 127, 128, 254]);
    for (let start = 0; start <= allocation.length; start += 1) {
      for (let end = start; end <= allocation.length; end += 1) {
        const view = allocation.subarray(start, end);
        expect(
          businessRegistryCredentials.ciphertext.mapFromDriverValue(view),
        ).toEqual(Buffer.from(allocation.slice(start, end)));
      }
    }
  });

  test.each([null, {}, [0, 255], new DataView(new ArrayBuffer(2)), 42])(
    "rejects unsupported driver values instead of guessing their encoding",
    (value) => {
      expect(() =>
        businessRegistryCredentials.ciphertext.mapFromDriverValue(value),
      ).toThrow("Unexpected bytea driver value");
    },
  );
});
