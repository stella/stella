import { installPreloadErrorRecovery } from "@/lib/preload-error-recovery";
import { startWebHangDetector } from "@/lib/web-hang-detector";

// The runtime chunk can fail before any of its modules evaluate.
installPreloadErrorRecovery();
// Run before importing stores that synchronously restore persisted layout.
startWebHangDetector();
import("@/client-runtime").catch((error: unknown) => {
  reportError(error);
});
