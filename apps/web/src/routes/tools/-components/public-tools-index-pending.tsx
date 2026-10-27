import { Skeleton } from "@stll/ui/skeleton";

/** Keeps the catalogue's visible first-screen geometry stable while its route
 * chunk loads. The public shell owns the surrounding chrome. */
export const PublicToolsIndexPending = () => (
  <main aria-hidden="true" className="min-h-0 flex-1 overflow-hidden">
    <div className="mx-auto flex w-full max-w-6xl flex-col px-5 py-8 sm:px-8 lg:px-10 lg:py-10">
      <section className="pb-4">
        <div className="max-w-3xl">
          <Skeleton className="h-9 w-2/3 max-w-2xl" />
          <Skeleton className="mt-2 h-7 w-4/5" />
        </div>
        <Skeleton className="mt-6 h-12 max-w-3xl rounded-md" />
        <div className="mt-5">
          <Skeleton className="h-3 w-32" />
          <div className="mt-2 flex flex-nowrap gap-2 overflow-hidden sm:flex-wrap">
            <Skeleton className="h-11 w-40 shrink-0 rounded-md" />
            <Skeleton className="h-11 w-40 shrink-0 rounded-md" />
            <Skeleton className="h-11 w-40 shrink-0 rounded-md" />
            <Skeleton className="h-11 w-40 shrink-0 rounded-md" />
            <Skeleton className="h-11 w-40 shrink-0 rounded-md" />
          </div>
        </div>
      </section>

      <section className="pt-8 lg:pt-10">
        <div className="mb-5 flex items-center justify-between gap-2">
          <Skeleton className="h-8 w-44" />
          <Skeleton className="h-11 w-36 rounded-md" />
        </div>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,0.85fr)_minmax(0,0.85fr)]">
          <Skeleton className="h-80 rounded-2xl sm:col-span-2 xl:col-span-1" />
          <Skeleton className="h-80 rounded-2xl" />
          <Skeleton className="h-80 rounded-2xl" />
        </div>
      </section>

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
