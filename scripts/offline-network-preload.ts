import { TaggedError } from "better-result";

// The preload is confined to verification: refresh commands retain their transport.
class OfflineCheckNetworkError extends TaggedError("OfflineCheckNetworkError")<{
  message: string;
}> {}

if (process.argv.includes("--check")) {
  Object.defineProperty(globalThis, "fetch", {
    configurable: false,
    writable: false,
    value: () => {
      process.exitCode = 1;
      throw new OfflineCheckNetworkError({
        message:
          "Offline check attempted a network fetch; refresh committed inputs separately",
      });
    },
  });
}
