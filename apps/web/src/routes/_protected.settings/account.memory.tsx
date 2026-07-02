import { createFileRoute } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { Skeleton } from "@stll/ui/components/skeleton";

import { MemoryPanel } from "@/routes/_protected.settings/-components/organization/memory/memory-panel";
import { SettingsPageHeader } from "@/routes/_protected.settings/-components/settings-page-header";

export const Route = createFileRoute("/_protected/settings/account/memory")({
  component: MemoryPage,
  pendingComponent: MemoryPagePending,
});

const MEMORY_TAB_SKELETON_KEYS = ["mine", "firm", "matter"] as const;
const MEMORY_ROW_SKELETON_KEYS = ["primary", "secondary", "tertiary"] as const;

function MemoryPagePending() {
  return (
    <>
      <header className="flex flex-col gap-1">
        <Skeleton className="h-7 w-24" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </header>

      <section className="flex flex-col gap-2">
        <div className="bg-muted flex w-fit items-center gap-0.5 rounded-lg p-0.5">
          {MEMORY_TAB_SKELETON_KEYS.map((key) => (
            <Skeleton className="h-8 w-24 rounded-md" key={key} />
          ))}
        </div>

        <div className="flex flex-col gap-6 pt-4">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-16 w-full rounded-lg" />
          </div>

          <div className="flex flex-col gap-2">
            <Skeleton className="h-20 w-full rounded-md" />
            <div className="flex justify-end">
              <Skeleton className="h-9 w-24 rounded-md" />
            </div>
          </div>

          <div className="flex flex-col gap-2">
            {MEMORY_ROW_SKELETON_KEYS.map((key) => (
              <Skeleton className="h-24 w-full rounded-lg" key={key} />
            ))}
          </div>
        </div>
      </section>
    </>
  );
}

function MemoryPage() {
  const t = useTranslations();

  return (
    <>
      <SettingsPageHeader
        description={t("memory.pageDescription")}
        title={t("memory.pageTitle")}
      />
      <MemoryPanel />
    </>
  );
}
