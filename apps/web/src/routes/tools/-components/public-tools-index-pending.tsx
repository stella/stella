import { Skeleton } from "@stll/ui/skeleton";

import { PublicToolsFeatured } from "@/routes/tools/-components/public-tools-featured";
import { PUBLIC_TOOL_TASKS } from "@/routes/tools/-components/public-tools-index.logic";
import { PublicToolsTaskGrid } from "@/routes/tools/-components/public-tools-task-grid";

/** Keeps the catalogue's visible first-screen geometry stable while its route
 * chunk loads. The featured cards are the loaded ones, whose height follows
 * their content and language; inert keeps their links out of reach until the
 * page replaces them. The public shell owns the surrounding chrome. */
export const PublicToolsIndexPending = () => (
  <main className="min-h-0 flex-1 overflow-hidden" inert>
    <div className="mx-auto flex w-full max-w-6xl flex-col px-5 py-8 sm:px-8 lg:px-10 lg:py-10">
      <section className="pb-4">
        <div className="max-w-3xl">
          <Skeleton className="h-9 w-2/3 max-w-2xl" />
          <Skeleton className="mt-2 h-7 w-4/5" />
        </div>
        <Skeleton className="mt-6 h-12 max-w-3xl rounded-md" />
        <div className="mt-5">
          <Skeleton className="h-3 w-32" />
          <PublicToolsTaskGrid>
            {PUBLIC_TOOL_TASKS.map((task) => (
              <Skeleton className="h-11 rounded-md" key={task} />
            ))}
          </PublicToolsTaskGrid>
        </div>
      </section>

      <PublicToolsFeatured />

      <section className="pt-10 lg:pt-12">
        <div className="flex items-end justify-between gap-4">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-8 w-36" />
            <Skeleton className="h-4 w-72 max-w-full" />
          </div>
          <Skeleton className="h-11 w-40 rounded-md" />
        </div>
        <div className="mt-8 flex flex-col gap-3">
          <Skeleton className="h-28 rounded-xl" />
          <Skeleton className="h-28 rounded-xl" />
          <Skeleton className="h-28 rounded-xl" />
        </div>
      </section>
    </div>
  </main>
);
