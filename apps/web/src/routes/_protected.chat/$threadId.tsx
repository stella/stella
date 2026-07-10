import { createFileRoute } from "@tanstack/react-router";

import { Skeleton } from "@stll/ui/components/skeleton";

import { toChatThreadId } from "@/lib/chat-thread-ref";
import { ensureRouteQueryData } from "@/lib/react-query";
import { ChatThreadPage } from "@/routes/_protected.chat/-components/chat-thread-page";
import { chatThreadOptions } from "@/routes/_protected.chat/-queries";

export const Route = createFileRoute("/_protected/chat/$threadId")({
  component: ThreadRoute,
  pendingComponent: ChatThreadPending,
  // Most threads load instantly from cache, so hold the skeleton back for
  // 1s — it only appears when the load actually stalls, avoiding a flash
  // between two consecutive chats.
  pendingMs: 1000,
  loader: async ({ context, params }) => {
    // Prime the pure thread-data query the page suspends on so the fetch
    // starts during navigation instead of after the component mounts and
    // suspends. `context` here is a key-shape stub only (no live getters):
    // `chatThreadOptions` never builds a `ChatRuntime` from it — the
    // component builds that separately, from its own live getters, via
    // `useChatThreadRuntime`. See that factory's docs.
    const threadQueryOptions = chatThreadOptions({
      activeOrganizationId: context.user.activeOrganizationId,
      key: {
        scope: "global",
        threadId: toChatThreadId(params.threadId),
      },
      context: { allowMissingThread: true },
    });
    // Cached data — fresh, stale, or invalidated — renders immediately;
    // the component's own observer background-refetches stale entries
    // after mount and the runtime registry's idle reconcile picks the
    // refetched messages up. Awaiting a refetch here would block first
    // paint on a warm navigation and, worse, clobber the "move to main"
    // seeding: `buildMaximizeTabAction` seeds this key with the inspector
    // tab's unpersisted `contextMatterIds` and then invalidates, so an
    // awaited refetch would replace the seed with the server's (possibly
    // empty) set before the page's matter picker ever saw it. The loader
    // only fills a cold cache.
    if (
      context.queryClient.getQueryData(threadQueryOptions.queryKey) !==
      undefined
    ) {
      return;
    }
    await ensureRouteQueryData(context.queryClient, threadQueryOptions);
  },
});

function ThreadRoute() {
  const threadId = Route.useParams({
    select: (params) => toChatThreadId(params.threadId),
  });

  return <ChatThreadPage threadRef={{ scope: "global", threadId }} />;
}

const CHAT_SKELETON_BUBBLES = [
  { key: "a", side: "user" },
  { key: "b", side: "assistant" },
  { key: "c", side: "user" },
  { key: "d", side: "assistant" },
] as const;

// Mirrors the ChatThreadPage shell: top bar, conversation area, and the input
// surface — so the chat structure is visible immediately instead of a logo.
function ChatThreadPending() {
  return (
    <div className="flex w-full flex-1 flex-col overflow-hidden">
      <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-2 px-4 py-2">
        <div className="flex items-center gap-2">
          <Skeleton className="h-8 w-24 rounded-md" />
          <Skeleton className="h-8 w-32 rounded-md" />
        </div>
        <div className="flex items-center gap-1">
          <Skeleton className="size-8 rounded-md" />
          <Skeleton className="size-8 rounded-md" />
          <Skeleton className="size-8 rounded-md" />
        </div>
      </div>

      <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-4 overflow-hidden px-4 py-4">
        {CHAT_SKELETON_BUBBLES.map((bubble) =>
          bubble.side === "user" ? (
            <div className="flex justify-end" key={bubble.key}>
              <Skeleton className="h-12 w-2/5 rounded-2xl" />
            </div>
          ) : (
            <div className="flex flex-col gap-2" key={bubble.key}>
              <Skeleton className="h-4 w-4/5" />
              <Skeleton className="h-4 w-3/5" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          ),
        )}
      </div>

      <div className="mx-auto w-full max-w-5xl p-4">
        <Skeleton className="h-24 w-full rounded-xl" />
      </div>
    </div>
  );
}
