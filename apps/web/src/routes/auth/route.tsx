import { createFileRoute, Outlet } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { StellaWordmark } from "@/components/stella-wordmark";

export const Route = createFileRoute("/auth")({
  component: AuthLayout,
});

function AuthLayout() {
  const t = useTranslations();

  return (
    <div className="auth-gradient flex min-h-dvh flex-col">
      <style>{`
        .auth-gradient {
          background: linear-gradient(
            to bottom,
            var(--background) 40%,
            var(--auth-gradient-end)
          );
        }
        :root { --auth-gradient-end: #cbe1fc; }
        .dark { --auth-gradient-end: #1a3a5c; }
      `}</style>
      <div className="flex flex-1 flex-col px-8 lg:px-16 xl:px-24">
        <header className="pt-12">
          <StellaWordmark className="text-foreground h-6 w-auto" />
        </header>
        <div className="flex flex-1 flex-col items-center min-[70rem]:flex-row min-[70rem]:items-baseline">
          <div className="hidden flex-1 pt-[18vh] min-[70rem]:block">
            <h1 className="text-foreground max-w-xl text-[2.75rem] leading-[1.15] font-light tracking-tight">
              {t("auth.headline")}
            </h1>
            <p className="text-muted-foreground mt-5 max-w-md text-base">
              {t("auth.subtitle")}
            </p>
          </div>
          <div className="flex w-full min-w-0 flex-1 items-start justify-center pt-12 min-[70rem]:justify-start min-[70rem]:pt-[18vh]">
            <Outlet />
          </div>
        </div>
      </div>
    </div>
  );
}
