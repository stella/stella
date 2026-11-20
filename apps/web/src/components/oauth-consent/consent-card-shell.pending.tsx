import type { ComponentType, ReactNode } from "react";

import { FaceLabelPending } from "@stll/ui/control-face";
import { PlugIcon } from "@stll/ui/icons";
import { StellaMark } from "@stll/ui/stella-mark";
import { cn } from "@stll/ui/utils";

type BodyProps = { children: ReactNode };

const BodyPending = ({ children }: BodyProps) => (
  <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
);

export const ConsentCardShell = ({
  tiles,
  title,
  verification,
  details,
  children,
  decision,
  Body = BodyPending,
}: {
  tiles: ReactNode;
  title: ReactNode;
  verification: ReactNode;
  details: ReactNode;
  children: ReactNode;
  decision: ReactNode;
  Body?: ComponentType<BodyProps>;
}) => (
  <main className="bg-muted/40 flex h-dvh flex-1 sm:px-6 sm:py-6">
    <div
      className="bg-background flex size-full max-h-dvh flex-col shadow-sm sm:m-auto sm:h-auto sm:max-h-full sm:max-w-xl sm:overflow-hidden sm:rounded-2xl"
      data-slot="consent-card"
    >
      <Body>
        <header className="flex flex-col gap-5 px-6 pt-6 pb-4">
          <div className="flex items-center justify-between gap-4">
            {tiles}
            {details}
          </div>
          <div className="flex min-w-0 flex-col gap-2">
            <h1 className="text-xl leading-tight font-semibold text-balance sm:text-2xl">
              {title}
            </h1>
            {verification}
          </div>
        </header>
        <div className="flex flex-col gap-5 px-6 pt-2 pb-6">{children}</div>
      </Body>
      {decision}
    </div>
  </main>
);

const TILE_CLASS =
  "bg-background outline-foreground/8 flex size-11 shrink-0 items-center justify-center rounded-xl shadow-xs outline-1";

export const ConsentClientTilePair = ({ client }: { client: ReactNode }) => (
  <div className="flex items-center gap-3" aria-hidden="true">
    <div className={cn(TILE_CLASS, "text-lg font-medium")}>{client}</div>
    <span className="text-muted-foreground">+</span>
    <div className={TILE_CLASS}>
      <StellaMark className="size-6" />
    </div>
  </div>
);

export const consentChromePending = {
  tiles: <ConsentClientTilePair client={<PlugIcon className="size-6" />} />,
  title: (
    <span className="flex">
      <FaceLabelPending className="w-52" />
    </span>
  ),
  verification: (
    <div className="flex min-h-11 items-center text-sm">
      <FaceLabelPending className="w-24" />
    </div>
  ),
};
