import type { PropsWithChildren, ReactNode } from "react";

import { ScrollArea } from "@stll/ui/scroll-area";
import { Skeleton } from "@stll/ui/skeleton";

/**
 * The shell every public law hub page shares, and its loading pieces. The hub
 * routes render these eagerly while the page chunk and its reads load; each
 * page renders the same shell, so the layout the reader lands on is the one
 * that waited.
 */

export const PublicLawHubLayout = ({
  children,
  crumbs,
  header,
}: PropsWithChildren<{
  crumbs?: ReactNode;
  header: ReactNode;
}>) => (
  <main className="flex min-h-0 flex-1 flex-col">
    <ScrollArea className="min-h-0 flex-1">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 p-3 sm:p-6">
        {crumbs}
        {header}
        {children}
      </div>
    </ScrollArea>
  </main>
);

/** A hub's heading and its one sentence. */
export const PublicLawHubHeader = ({
  description,
  title,
}: {
  description: string;
  title: string;
}) => (
  <header className="flex flex-col gap-1">
    <h1 className="text-lg font-semibold wrap-break-word">{title}</h1>
    <p className="text-muted-foreground text-sm">{description}</p>
  </header>
);

const PublicLawHubHeaderPending = () => (
  <div className="flex flex-col gap-1">
    <Skeleton className="my-1 h-5 w-56 max-w-full" />
    <Skeleton className="my-0.5 h-4 w-80 max-w-full" />
  </div>
);

const PENDING_LINKS = 9;

/** A hub before its reads are in: the heading, and a section of links. */
export const PublicLawHubPending = () => (
  <PublicLawHubLayout header={<PublicLawHubHeaderPending />}>
    <div className="flex flex-col gap-2">
      <Skeleton className="my-0.5 h-3 w-24" />
      <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: PENDING_LINKS }, (_, index) => (
          <div className="flex min-h-11 items-center px-2" key={index}>
            <Skeleton className="h-4 w-40 max-w-full" />
          </div>
        ))}
      </div>
    </div>
  </PublicLawHubLayout>
);
