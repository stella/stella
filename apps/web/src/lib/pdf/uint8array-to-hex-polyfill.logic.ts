const HEX_BYTE_WIDTH = 2;
const HEX_RADIX = 16;

export const installUint8ArrayToHexPolyfill = () => {
  if (typeof Uint8Array.prototype.toHex === "function") {
    return;
  }

  // eslint-disable-next-line no-extend-native -- PDF.js v5 calls the platform Uint8Array#toHex API; older browsers need this compatibility shim.
  Object.defineProperty(Uint8Array.prototype, "toHex", {
    configurable: true,
    value: function toHex(this: Uint8Array): string {
      if (!(this instanceof Uint8Array)) {
        throw new TypeError(
          "Uint8Array.prototype.toHex called on incompatible receiver",
        );
      }

      const hexBytes: string[] = [];
      for (const byte of this) {
        hexBytes.push(byte.toString(HEX_RADIX).padStart(HEX_BYTE_WIDTH, "0"));
      }

      return hexBytes.join("");
    },
    writable: true,
  });
};
