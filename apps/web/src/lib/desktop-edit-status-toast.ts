import { stellaToast } from "@stll/ui/components/toast";

import type { TranslationKey } from "@/i18n/types";
import type { OpenDocxInDesktopResult } from "@/lib/desktop-bridge";

type DesktopEditToastTranslator = (key: TranslationKey) => string;

export const showDesktopEditOpenResultToast = async ({
  result,
  t,
}: {
  result: OpenDocxInDesktopResult;
  t: DesktopEditToastTranslator;
}) => {
  if (result.type === "opened") {
    stellaToast.add({
      description: t("workspaces.files.desktopEdit.openedDescription"),
      title: t("workspaces.files.desktopEdit.openedTitle"),
      type: "success",
    });
    return;
  }

  const toastId = stellaToast.add({
    description: t("workspaces.files.desktopEdit.sentDescription"),
    title: t("workspaces.files.desktopEdit.sentTitle"),
    type: "loading",
  });

  try {
    await result.waitUntilOpened;
    stellaToast.update(toastId, {
      description: t("workspaces.files.desktopEdit.openedDescription"),
      title: t("workspaces.files.desktopEdit.openedTitle"),
      type: "success",
    });
  } catch {
    stellaToast.update(toastId, {
      description: t("workspaces.files.desktopEdit.notOpenedDescription"),
      title: t("workspaces.files.desktopEdit.unavailableTitle"),
      type: "error",
    });
  }
};
