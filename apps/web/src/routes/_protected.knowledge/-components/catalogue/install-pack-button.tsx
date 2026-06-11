import { useState } from "react";

import { LoaderIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { stellaToast } from "@stll/ui/components/toast";

import type { CatalogueEntry } from "./catalogue-types";
import { useInstallEntry } from "./use-install-entry";

type InstallPackButtonProps = {
  entries: readonly CatalogueEntry[];
  organizationId: string;
};

/**
 * Fires N install mutations in parallel. Partial failures surface as
 * a per-failed-item toast; the user can retry individuals from the
 * card below. No transactional rollback — deliberate per plan.
 */
export const InstallPackButton = ({
  entries,
  organizationId,
}: InstallPackButtonProps) => {
  const t = useTranslations();
  const install = useInstallEntry(organizationId);
  const [busy, setBusy] = useState(false);

  const installable = entries.filter(
    (entry) => entry.installState === "available",
  );

  if (installable.length === 0) {
    return null;
  }

  const onClick = async () => {
    setBusy(true);
    try {
      const results = await Promise.allSettled(
        installable.map(async (entry) => {
          await install.mutateAsync(entry);
          return entry;
        }),
      );

      const failures = results.filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );

      if (failures.length === 0) {
        stellaToast.add({
          title: t("catalogue.packInstalled", {
            count: installable.length,
          }),
          type: "success",
        });
      } else {
        stellaToast.add({
          title: t("catalogue.packPartial", {
            installed: String(installable.length - failures.length),
            failed: String(failures.length),
          }),
          type: "warning",
        });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button
      disabled={busy}
      onClick={() => {
        void onClick();
      }}
      size="xs"
      variant="outline"
    >
      {busy && <LoaderIcon className="size-3.5 animate-spin" />}
      {t("catalogue.installPack", { count: installable.length })}
    </Button>
  );
};
