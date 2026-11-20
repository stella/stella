import type { ReactNode } from "react";

import { useSearch } from "@tanstack/react-router";

import { cn } from "@stll/ui/utils";

import { framePendingView } from "@/routes/-pending-view.logic";
import {
  resolveVisualName,
  visualRegistry,
} from "@/routes/dev/-visual-metadata";
import type { VisualName } from "@/routes/dev/-visual-metadata";

type FixtureSectionProps = {
  visual: VisualName;
  children?: ReactNode;
};

export const FixtureSection = ({ visual, children }: FixtureSectionProps) => (
  <section
    className={cn(
      "bg-background flex flex-1 flex-col",
      // Plain fixtures grow in the page; pane layouts own bounded scroll areas.
      visualRegistry[visual].layout !== "plain" && "min-h-0",
    )}
    data-playground-section={`fixture:${visual}`}
  >
    <header className="text-muted-foreground shrink-0 px-4 py-2 text-xs">
      Fixture: {visualRegistry[visual].label}
    </header>
    {children}
  </section>
);

export function DevShell({ visual, children }: FixtureSectionProps) {
  return (
    <main className="bg-background flex min-h-0 flex-1 flex-col overflow-y-auto">
      <FixtureSection visual={visual}>{children}</FixtureSection>
    </main>
  );
}

export const DevPending = framePendingView(() => {
  const visual = useSearch({
    strict: false,
    select: (search) => resolveVisualName(search.visual),
  });
  return <DevShell visual={visual} />;
});
