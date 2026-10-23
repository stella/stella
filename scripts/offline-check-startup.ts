import { TaggedError } from "better-result";

export class OfflineCheckPreloadMissing extends TaggedError(
  "OfflineCheckPreloadMissing",
)<{
  message: string;
}> {}

const marker = Symbol.for("stella.offline-check-preload");

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
  throw new OfflineCheckPreloadMissing({
    message:
      "offline check network guard is not active; run this check with `bun --preload ./scripts/offline-network-preload.ts <check> --check`",
  });
};
