import { bootClientRuntime } from "@/lib/analytics/web-hang/client-bootstrap";
import {
  installPreloadErrorRecovery,
  loadInitialRuntimeWithRecovery,
} from "@/lib/preload-error-recovery";

// The runtime chunk can fail before any of its modules evaluate.
installPreloadErrorRecovery();
bootClientRuntime({
  // Start detection before stores restore layout; load the runtime even if detection fails.
  loadRuntime: async () =>
    loadInitialRuntimeWithRecovery({
      load: async () => import("@/client-runtime"),
    }),
  captureDetectorError: (error) => reportError(error),
}).catch((error: unknown) => {
  reportError(error);
});
