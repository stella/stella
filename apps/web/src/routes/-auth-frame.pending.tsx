import type { ComponentType, ReactNode, SVGProps } from "react";

import { GlobeIcon, MonitorIcon } from "@stll/ui/icons";
import { StellaWordmarkLatin } from "@stll/ui/stella-wordmark";

import { PendingText } from "@/components/pending-text";
import { PickerTriggerPending } from "@/components/picker-trigger.pending";

export const AuthPickersPending = () => (
  <>
    <PickerTriggerPending icon={MonitorIcon} />
    <PickerTriggerPending icon={GlobeIcon} />
  </>
);

export const AuthFrameShell = ({
  children,
  pickers,
  wordmark: Wordmark = StellaWordmarkLatin,
}: {
  children: ReactNode;
  pickers?: ReactNode;
  wordmark?: ComponentType<SVGProps<SVGSVGElement>>;
}) => (
  <div className="auth-gradient flex min-h-dvh shrink-0 flex-col">
    <div className="flex flex-1 flex-col px-8 pb-12 lg:px-16 xl:px-24">
      <header className="flex flex-wrap items-end justify-between gap-4 pt-12">
        <div className="flex items-center gap-3">
          <a
            aria-label="Stella"
            className="inline-flex transition-opacity hover:opacity-80"
            href="https://stll.app"
          >
            <Wordmark className="text-foreground h-6 w-auto" />
          </a>
        </div>
        <div className="flex items-center gap-2">
          {pickers ?? <AuthPickersPending />}
        </div>
      </header>
      <div className="flex flex-1 flex-col items-center min-[70rem]:flex-row min-[70rem]:items-start">
        <div className="hidden flex-1 pt-[18svh] min-[70rem]:block">
          <h1 className="text-foreground max-w-xl text-[2.75rem] leading-[1.15] font-light tracking-tight">
            <PendingText barClassName="w-72" id="auth.headline" />
          </h1>
          <p className="text-muted-foreground mt-5 max-w-md text-base">
            <PendingText barClassName="w-64" id="auth.subtitle" />
          </p>
        </div>
        <div className="flex w-full min-w-0 flex-1 items-start justify-center pt-12 min-[70rem]:justify-start min-[70rem]:pt-[18svh]">
          {children}
        </div>
      </div>
    </div>
  </div>
);
