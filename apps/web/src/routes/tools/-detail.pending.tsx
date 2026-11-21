import type { ReactNode } from "react";

import { ButtonFace } from "@stll/ui/control-face";
import { InlineSkeleton, Skeleton } from "@stll/ui/skeleton";

import { PendingText } from "@/components/pending-text";
import { framePendingView } from "@/routes/-pending-view.logic";

type PublicToolDetailShellProps = {
  actions: ReactNode;
  author: ReactNode;
  badges: ReactNode;
  children: ReactNode;
  description: ReactNode;
  firstPartyMark?: ReactNode;
  headerIcon: ReactNode;
  tags?: readonly ReactNode[];
  title: ReactNode;
};

export function PublicToolDetailShell({
  actions,
  author,
  badges,
  children,
  description,
  firstPartyMark,
  headerIcon,
  tags,
  title,
}: PublicToolDetailShellProps) {
  return (
    <main className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-6">
        <div className="flex items-start gap-3">
          {headerIcon}
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-lg font-semibold" dir="auto">
                {title}
              </h1>
              {firstPartyMark}
            </div>
            <p className="text-muted-foreground text-sm">{author}</p>
          </div>
        </div>

        <p className="text-foreground text-sm" dir="auto">
          {description}
        </p>

        <div className="flex flex-wrap items-center gap-1.5">{badges}</div>

        {tags !== undefined && tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5">{tags}</div>
        )}

        <div className="flex flex-wrap items-center gap-2">{actions}</div>

        <div className="border-border mt-2 border-t pt-4">{children}</div>
      </div>
    </main>
  );
}

export const PublicToolDetailPending = framePendingView(() => (
  <PublicToolDetailShell
    actions={
      <ButtonFace size="default" variant="default">
        <PendingText id="publicTools.addToStella" />
      </ButtonFace>
    }
    author={<InlineSkeleton className="h-3 w-28" />}
    badges={
      <>
        <Skeleton className="h-5 w-12" />
        <Skeleton className="h-5 w-16" />
        <Skeleton className="h-5 w-12" />
      </>
    }
    description={<InlineSkeleton className="h-3 w-4/5" />}
    headerIcon={<Skeleton className="mt-0.5 size-8 shrink-0 rounded-md" />}
    title={<InlineSkeleton className="h-4 w-48" />}
  >
    <div className="flex flex-col gap-3">
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-5/6" />
    </div>
  </PublicToolDetailShell>
));
