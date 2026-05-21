const HEX_BYTE_WIDTH = 2;
const HEX_RADIX = 16;
const HEX_TABLE = Array.from({ length: 256 }, (_, byte) =>
  byte.toString(HEX_RADIX).padStart(HEX_BYTE_WIDTH, "0"),
);

export const installUint8ArrayToHexPolyfill = () => {
  if (typeof Uint8Array.prototype.toHex === "function") {
    return;
  }

  // eslint-disable-next-line no-extend-native -- PDF.js v5 calls the platform Uint8Array#toHex API; older browsers need this compatibility shim.
  Object.defineProperty(Uint8Array.prototype, "toHex", {
    configurable: true,
    // eslint-disable-next-line func-name-matching -- name kept for stack traces; semantically matches the "toHex" property
    value: function toHex(this: Uint8Array): string {
      if (!(this instanceof Uint8Array)) {
        throw new TypeError(
          "Uint8Array.prototype.toHex called on incompatible receiver",
        );
      }

      const hexBytes: string[] = [];
      for (let i = 0; i < this.length; i++) {
        const byte = this[i];
        if (byte === undefined) {
          throw new TypeError("Uint8Array byte index out of bounds");
        }

        const hex = HEX_TABLE[byte];
        if (hex === undefined) {
          throw new TypeError("Uint8Array byte value out of bounds");
        }

        hexBytes.push(hex);
      }

      return hexBytes.join("");
    },
    writable: true,
  });
};
