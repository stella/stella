import type { ReactNode } from "react";
// The playbooks page's shape: light presentational pieces only (a
// pending-safe module, see .oxlint-plugins/route-pending-component-policy.json),
// so the pending views draw them before any provider mounts.

import { Skeleton } from "@stll/ui/skeleton";

/** The playbooks page's column. The loaded page scrolls it; its pending
 *  phase is a placeholder of the same geometry, which does not. */
export const PlaybooksPageFrame = ({ children }: { children: ReactNode }) => (
  <div className="mx-auto flex w-full max-w-6xl flex-col gap-9 px-5 py-7 sm:px-7 sm:py-9">
    {children}
  </div>
);

const STARTER_KEYS = ["starter-a", "starter-b", "starter-c", "starter-d"];
const PLAYBOOK_ROW_KEYS = ["a", "b", "c", "d", "e", "f"];

// Mirrors the playbooks page (header, ready-made cards, list rows) so the page
// keeps its shape while the playbooks load.
export const PlaybooksPagePending = () => (
  <div className="min-h-0 flex-1 overflow-hidden">
    <PlaybooksPageFrame>
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-2">
          <Skeleton className="h-7 w-36" />
          <Skeleton className="h-4 w-96 max-w-full" />
        </div>
        <Skeleton className="h-11 w-36 rounded-md" />
      </div>
      <div>
        <Skeleton className="mb-3 h-5 w-44" />
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {STARTER_KEYS.map((key) => (
            <Skeleton className="h-44 rounded-xl" key={key} />
          ))}
        </div>
      </div>
      <div>
        <Skeleton className="mb-3 h-5 w-28" />
        <ul className="divide-y rounded-xl border">
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
      </div>
    </PlaybooksPageFrame>
  </div>
);
