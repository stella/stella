import { startWebHangDetector } from "@/lib/web-hang-detector";

// Run before importing stores that synchronously restore persisted layout.
startWebHangDetector();
import("@/client-runtime").catch((error: unknown) => {
  reportError(error);
});
