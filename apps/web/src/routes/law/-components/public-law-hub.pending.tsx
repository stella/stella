import type { PropsWithChildren, ReactNode } from "react";

import { FaceLabelPending } from "@stll/ui/control-face";

/**
 * The shell every public law hub page shares, and its loading pieces. The hub
 * routes render these eagerly while the page chunk and its reads load; each
 * page renders the same shell, so the layout the reader lands on is the one
 * that waited. The cold-load frame draws the pending view before any provider
 * mounts, so this module stays context-free: the page scrolls the shell in a
 * `ScrollArea` (`PublicLawHubScroll`), the pending view sits in plain boxes of
 * the same geometry (nothing in a placeholder scrolls).
 */

/** The hub's one column: the crumb trail, the header and the sections. */
export const PublicLawHubLayout = ({
  children,
  crumbs,
  header,
}: PropsWithChildren<{
  crumbs?: ReactNode;
  header: ReactNode;
}>) => (
  <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 p-3 sm:p-6">
    {crumbs}
    {header}
    {children}
  </div>
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

/**
 * The heading and the sentence at their type sizes. The sentence's line is a
 * `div`, not a `p`: a bar is a block, and the HTML parser closes a paragraph
 * at a block, so the server's paint would no longer match the tree the client
 * hydrates.
 */
const PublicLawHubHeaderPending = () => (
  <header className="flex flex-col gap-1">
    <h1 className="text-lg font-semibold">
      <FaceLabelPending className="w-56 max-w-full" />
    </h1>
    <div className="text-muted-foreground text-sm">
      <FaceLabelPending className="w-80 max-w-full" />
    </div>
  </header>
);

const PENDING_LINKS = 9;

/** A section's heading and its grid of links, at the rows' height. */
const PublicLawHubSectionPending = () => (
  <div aria-hidden="true" className="flex flex-col gap-2">
    <div className="text-xs font-medium">
      <FaceLabelPending className="w-24" />
    </div>
    <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: PENDING_LINKS }, (_, index) => (
        <div className="flex min-h-11 items-center px-2 text-sm" key={index}>
          <FaceLabelPending className="w-40 max-w-full" />
        </div>
      ))}
    </div>
  </div>
);

/**
 * A hub before its reads are in: the heading and a section of links, inside
 * the scroll area's root and viewport boxes.
 */
export const PublicLawHubPending = () => (
  <main className="flex min-h-0 flex-1 flex-col">
    {/* `ScrollArea`'s root and viewport boxes, without the scrolling. */}
    <div className="flex size-full min-h-0 flex-1 flex-col">
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-[inherit]">
        <PublicLawHubLayout header={<PublicLawHubHeaderPending />}>
          <PublicLawHubSectionPending />
        </PublicLawHubLayout>
      </div>
    </div>
  </main>
);
