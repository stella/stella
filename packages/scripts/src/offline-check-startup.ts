import assert from "node:assert/strict";

const marker = Symbol.for("stella.offline-check-preload");

export const installOfflineCheckPreloadMarker = () => {
  Object.defineProperty(globalThis, marker, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: true,
  });
};

/** Refuse check mode unless the network-denying preload proved it ran. */
export const assertOfflineCheckPreload = () => {
  if (!process.argv.includes("--check")) {
    return;
  }
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, marker);
  if (
    descriptor?.value === true &&
    descriptor.configurable === false &&
    descriptor.enumerable === false &&
    descriptor.writable === false
  ) {
    return;
  }
  process.exitCode = 1;
  assert.fail(
    "OfflineCheckPreloadMissing: offline check network guard is not active; run this check with `bun --preload ./scripts/offline-network-preload.ts <check> --check`",
  );
};
