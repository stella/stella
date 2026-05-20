import { afterEach, describe, expect, test } from "bun:test";

import { installUint8ArrayToHexPolyfill } from "@/lib/pdf/uint8array-to-hex-polyfill.logic";

const originalToHex = Object.getOwnPropertyDescriptor(
  Uint8Array.prototype,
  "toHex",
);

const restoreToHex = () => {
  if (originalToHex) {
    // eslint-disable-next-line no-extend-native -- restore the browser/Bun prototype after testing the missing-API regression.
    Object.defineProperty(Uint8Array.prototype, "toHex", originalToHex);
    return;
  }

  Reflect.deleteProperty(Uint8Array.prototype, "toHex");
};

describe("PDF.js Uint8Array hex compatibility", () => {
  afterEach(() => {
    restoreToHex();
  });

  test("fills the missing Uint8Array.prototype.toHex API used by PDF.js v5 fingerprints", () => {
    Reflect.deleteProperty(Uint8Array.prototype, "toHex");

    installUint8ArrayToHexPolyfill();

    expect(new Uint8Array([0, 15, 16, 202, 254, 208, 13, 255]).toHex()).toBe(
      "000f10cafed00dff",
    );
  });

  test("keeps an existing browser implementation", () => {
    const nativeToHex = function nativeToHex() {
      return "native";
    };

    // eslint-disable-next-line no-extend-native -- simulate a browser-provided implementation so the polyfill does not replace it.
    Object.defineProperty(Uint8Array.prototype, "toHex", {
      configurable: true,
      value: nativeToHex,
      writable: true,
    });

    installUint8ArrayToHexPolyfill();

    expect(new Uint8Array([1]).toHex()).toBe("native");
  });
});
