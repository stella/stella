import { createFileRoute, Outlet } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { LanguagePicker } from "@/components/language-picker";
import { StellaWordmark } from "@/components/stella-wordmark";
import { ThemePicker } from "@/components/theme-picker";
import { loadAuthContext } from "@/routes/-auth-context";

const landingUrl = "https://stll.app";

export const Route = createFileRoute("/auth")({
  beforeLoad: async ({ context }) => await loadAuthContext(context.queryClient),
  component: AuthLayout,
});

function AuthLayout() {
  const t = useTranslations();

  return (
    <div className="auth-gradient flex min-h-dvh flex-col">
      <div className="fixed end-4 top-4 z-20 flex items-center gap-2 lg:end-8 lg:top-6">
        <ThemePicker />
        <LanguagePicker />
      </div>
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
          <div className="flex items-center gap-3">
            <a
              aria-label="stella"
              className="inline-flex transition-opacity hover:opacity-80"
              href={landingUrl}
            >
              <StellaWordmark className="text-foreground h-6 w-auto" />
            </a>
            <span className="border-border text-muted-foreground rounded-sm border px-1.5 py-0.5 text-[0.625rem] font-medium tracking-[0.1em] uppercase">
              {t("auth.betaNoticeTitle")}
            </span>
          </div>
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
