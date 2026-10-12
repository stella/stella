import { MCP_HANDOFF_STEP_UP_REQUIRED } from "@stll/api-contract/mcp-web-handoff";
import { stellaToast } from "@stll/ui/toast";

import { getTranslator } from "@/i18n/translator";
import { normalizeRedirectTo } from "@/lib/redirect";

const requiresStepUp = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  if ("code" in error && error.code === MCP_HANDOFF_STEP_UP_REQUIRED) {
    return true;
  }
  return (
    "error" in error &&
    typeof error.error === "object" &&
    error.error !== null &&
    "code" in error.error &&
    error.error.code === MCP_HANDOFF_STEP_UP_REQUIRED
  );
};

export const notifyStepUp = (error: unknown): boolean => {
  if (!requiresStepUp(error)) {
    return false;
  }
  const t = getTranslator();
  stellaToast.add({
    id: "mcp-handoff-step-up",
    type: "info",
    title: t("auth.reauthenticationRequired"),
    action: {
      label: t("auth.signIn"),
      onClick: () => {
        const path = normalizeRedirectTo(
          window.location.pathname + window.location.search,
        );
        window.location.assign(
          `/auth/reauth?redirectTo=${encodeURIComponent(path)}`,
        );
      },
    },
  });
  return true;
};
