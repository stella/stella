import { createFileRoute, Outlet } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { StellaWordmark } from "@/components/stella-wordmark";

export const Route = createFileRoute("/auth")({
  component: AuthLayout,
});

function AuthLayout() {
  const t = useTranslations();

  return (
    <div className="flex min-h-screen flex-col">
      <header className="px-8 pt-12 lg:px-16 xl:px-24">
        <StellaWordmark className="text-muted-foreground h-6 w-auto" />
      </header>
      <div className="flex flex-1 flex-col items-center lg:flex-row lg:items-start">
        <div className="hidden flex-1 px-16 pt-[18vh] lg:block xl:px-24">
          <h1 className="text-foreground max-w-md text-[2.75rem] leading-[1.15] font-light tracking-tight">
            {t("auth.headline")}
          </h1>
          <p className="text-muted-foreground mt-5 max-w-md text-base">
            {t("auth.subtitle")}
          </p>
        </div>
        <div className="flex flex-1 justify-center px-8 py-12 lg:justify-start lg:px-16 lg:pt-[18vh] xl:px-24">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
