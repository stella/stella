import type { ReactNode } from "react";

const ONBOARDING_GRADIENT_DARK_URL = "/branding/onboarding-gradient-dark.svg";
const ONBOARDING_GRADIENT_LIGHT_URL = "/branding/onboarding-gradient-light.svg";
const GRADIENT_MASK =
  "linear-gradient(to right, var(--foreground) 0%, var(--foreground) 14%, transparent 43%, transparent 62%, var(--foreground) 88%, var(--foreground) 100%)";

export const OnboardingLayoutShell = ({
  children,
  preview,
}: {
  children: ReactNode;
  preview: ReactNode;
}) => (
  <div className="flex h-dvh overflow-hidden" data-slot="onboarding-layout">
    {/* Left: form. overflow-y-auto so tall steps (AI provider/model
        picker, invite form) stay scrollable on short viewports
        instead of clipping the footer controls. */}
    <div className="flex w-full flex-col overflow-y-auto px-6 pt-[8svh] pb-10 md:w-1/2 md:px-12 md:pt-[10svh] lg:px-20">
      <div
        className="relative mx-auto flex min-h-0 w-full flex-1 flex-col"
        style={{ maxWidth: 460 }}
      >
        {children}
      </div>
    </div>

    {/* Right: preview — matches left column's vertical padding so the
        floating Theme/Language buttons (top-4) and the back arrow
        have breathing room above the card. */}
    <div className="bg-muted relative hidden items-center justify-center overflow-hidden px-6 pt-[10svh] pb-10 md:flex md:w-1/2">
      {/* The landing hero SVGs are the source of truth for these rays;
          onboarding only lowers their opacity. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{ maskImage: GRADIENT_MASK, WebkitMaskImage: GRADIENT_MASK }}
      >
        <img
          alt=""
          className="absolute inset-0 size-full opacity-25 dark:hidden"
          src={ONBOARDING_GRADIENT_LIGHT_URL}
        />
        <img
          alt=""
          className="absolute inset-0 hidden size-full opacity-[0.18] dark:block"
          src={ONBOARDING_GRADIENT_DARK_URL}
        />
      </div>
      <div className="relative z-10 flex h-full w-full items-center justify-center">
        {preview}
      </div>
    </div>
  </div>
);
