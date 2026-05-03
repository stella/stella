import type { PropsWithChildren } from "react";

import { Button } from "@stll/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { aiConfigOptions } from "@/routes/_protected.organization/-ai-config-queries";

/**
 * Whether AI features are available right now: either the org has
 * BYOK or the instance has provisioned keys. Returns true while
 * the config query is pending so callers don't flash gates on
 * first render.
 */
export function useAIAvailable(): boolean {
  const { data, isPending } = useQuery(aiConfigOptions);
  if (isPending || !data) {
    return true;
  }
  return data.configured || data.instanceProvisioned;
}

/**
 * Gate AI features when the instance has no provisioned keys
 * and the org has not supplied their own. Renders children when
 * either is available.
 */
export function RequireAIKey({ children }: PropsWithChildren) {
  const t = useTranslations();
  const { data, isPending } = useQuery(aiConfigOptions);

  if (isPending || !data) {
    return <>{children}</>;
  }

  if (data.configured || data.instanceProvisioned) {
    return <>{children}</>;
  }

  return (
    <div className="flex h-full w-full flex-1 items-center justify-center p-6">
      <div className="border-border bg-card text-card-foreground flex max-w-md flex-col gap-4 rounded-lg border p-6 shadow-sm">
        <div className="flex flex-col gap-1">
          <h2 className="text-foreground text-lg font-semibold">
            {t("ai.keyRequired.title")}
          </h2>
          <p className="text-muted-foreground text-sm">
            {t("ai.keyRequired.description")}
          </p>
        </div>
        <Button
          className="self-start"
          render={<Link to="/settings/organization/ai" />}
        >
          {t("ai.keyRequired.cta")}
        </Button>
      </div>
    </div>
  );
}
