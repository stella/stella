import type { PropsWithChildren, ReactNode } from "react";

import type { useTranslations } from "use-intl";

import { cn } from "@stll/ui/lib/utils";

export type Translate = ReturnType<typeof useTranslations<"outlook">>;

export const Panel = ({
  children,
  className,
}: PropsWithChildren<{ className?: string }>) => (
  <section className={cn("flex flex-col gap-3", className)}>{children}</section>
);

export const PanelTitle = ({
  icon,
  title,
}: {
  icon: ReactNode;
  title: string;
}) => (
  <div className="flex items-center gap-2">
    <span className="text-muted-foreground inline-flex">{icon}</span>
    <h2 className="truncate text-sm/5 font-medium">{title}</h2>
  </div>
);
