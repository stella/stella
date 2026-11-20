import type { ReactNode } from "react";
// The playbooks page's shape: light presentational pieces only (a
// pending-safe module, see .oxlint-plugins/route-pending-component-policy.json),
// so the pending views draw them before any provider mounts.

import { ButtonFace } from "@stll/ui/control-face";
import { PlusIcon, RotateCcwIcon } from "@stll/ui/icons";
import { Skeleton } from "@stll/ui/skeleton";

import { PendingText } from "@/components/pending-text";

/** The playbooks page's column. The loaded page scrolls it; its pending
 *  phase is a placeholder of the same geometry, which does not. */
export const PlaybooksPageFrame = ({ children }: { children: ReactNode }) => (
  <div className="mx-auto flex w-full max-w-6xl flex-col gap-9 px-5 py-7 sm:px-7 sm:py-9">
    {children}
  </div>
);

/** The page's header: its title and description, and the create action at
 *  its end. */
export const PlaybooksPageHeader = ({
  description,
  title,
  toolbar,
}: {
  description: ReactNode;
  title: ReactNode;
  toolbar: ReactNode;
}) => (
  <header className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="text-muted-foreground mt-1 max-w-2xl text-sm">
        {description}
      </p>
    </div>
    {toolbar}
  </header>
);

/** A section's heading row. */
export const PlaybooksSectionHeading = ({
  children,
  id,
}: {
  children: ReactNode;
  id?: string | undefined;
}) => (
  <div className="mb-3">
    <h2 className="text-base font-semibold" id={id}>
      {children}
    </h2>
  </div>
);

/** The library's heading row: its title, and the refresh action. */
export const PlaybooksLibraryHeading = ({
  children,
  id,
  refresh,
}: {
  children: ReactNode;
  id?: string | undefined;
  refresh: ReactNode;
}) => (
  <div className="mb-3 flex min-h-11 items-center justify-between gap-3">
    <h2 className="text-base font-semibold" id={id}>
      {children}
    </h2>
    {refresh}
  </div>
);

const STARTER_KEYS = ["starter-a", "starter-b", "starter-c", "starter-d"];
const PLAYBOOK_ROW_KEYS = ["a", "b", "c", "d", "e", "f"];

/** The ready-made playbook cards while they load. */
export const PlaybookStarterCardsPending = () => (
  <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
    {STARTER_KEYS.map((key) => (
      <Skeleton className="h-44 rounded-xl" key={key} />
    ))}
  </div>
);

/**
 * Which playbooks page loads: a member's library, whose create action and
 * ready-made cards their role decides, or the published catalogue of
 * ready-made playbooks alone.
 */
type PlaybooksPagePendingProps =
  { page: "library"; canCreate: boolean } | { page: "catalogue" };

// Mirrors the playbooks page (header, ready-made cards, list rows) so the page
// keeps its shape while the playbooks load.
export const PlaybooksPagePending = (props: PlaybooksPagePendingProps) => {
  const isLibrary = props.page === "library";
  const canCreate = isLibrary && props.canCreate;
  return (
    <div className="min-h-0 flex-1 overflow-hidden">
      <PlaybooksPageFrame>
        <PlaybooksPageHeader
          description={
            <PendingText
              barClassName="w-96 max-w-full"
              id="knowledge.playbooks.homeDescription"
            />
          }
          title={<PendingText barClassName="w-36" id="common.playbooks" />}
          toolbar={
            canCreate && (
              <ButtonFace
                className="h-11 shrink-0"
                size="default"
                variant="default"
              >
                <PlusIcon />
                <PendingText
                  barClassName="w-28"
                  id="knowledge.playbooks.createPlaybook"
                />
              </ButtonFace>
            )
          }
        />
        {(canCreate || !isLibrary) && (
          <section>
            <PlaybooksSectionHeading>
              <PendingText
                barClassName="w-44"
                id="knowledge.playbooks.recommended"
              />
            </PlaybooksSectionHeading>
            <PlaybookStarterCardsPending />
          </section>
        )}
        {isLibrary && (
          <section>
            <PlaybooksLibraryHeading
              refresh={
                <ButtonFace className="size-11" size="icon" variant="ghost">
                  <RotateCcwIcon />
                </ButtonFace>
              }
            >
              <PendingText barClassName="w-28" id="knowledge.playbooks.all" />
            </PlaybooksLibraryHeading>
            <ul aria-hidden="true" className="divide-y rounded-xl border">
              {PLAYBOOK_ROW_KEYS.map((key) => (
                <li className="flex min-h-16 items-center gap-3 px-4" key={key}>
                  <Skeleton className="size-9 shrink-0 rounded-lg" />
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <Skeleton className="h-4 w-48" />
                    <Skeleton className="h-3 w-32" />
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}
      </PlaybooksPageFrame>
    </div>
  );
};
