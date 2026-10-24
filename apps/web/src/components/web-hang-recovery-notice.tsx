import { useTranslations } from "use-intl";

import { stellaToast } from "@stll/ui/toast";

import { useMountEffect } from "@/hooks/use-effect";
import { getWebHangDetector } from "@/lib/analytics/web-hang/web-hang-detector";

export const WebHangRecoveryNotice = ({
  detector = getWebHangDetector(),
}: {
  detector?: ReturnType<typeof getWebHangDetector>;
}) => {
  const t = useTranslations();
  useMountEffect(() => {
    // Toast manager subscriptions attach after child mount effects.
    const frame = requestAnimationFrame(() => {
      detector?.notifyRecovery(() => {
        stellaToast.add({
          title: t("common.layoutResetAfterProblem"),
          type: "info",
        });
      });
    });
    return () => cancelAnimationFrame(frame);
  });
  return null;
};
