import { createFileRoute } from "@tanstack/react-router";

import { Skeleton } from "@stll/ui/components/skeleton";

import { toChatThreadId } from "@/lib/chat-thread-ref";
// oxlint-disable-next-line require-loader-prefetch/require-loader-prefetch -- chatThreadOptions builds the ChatRuntime from component-provided context getters (auth user, matter ids, send mode); a loader prefetch would cache a stub-context runtime under the same key and the first send would bypass anonymization. Fixing needs the queryFn split into a pure data fetch plus in-component runtime construction
import { ChatThreadPage } from "@/routes/_protected.chat/-components/chat-thread-page";

export const Route = createFileRoute("/_protected/chat/$threadId")({
  component: ThreadRoute,
  pendingComponent: ChatThreadPending,
  // Most threads load instantly from cache, so hold the skeleton back for
  // 1s — it only appears when the load actually stalls, avoiding a flash
  // between two consecutive chats.
  pendingMs: 1000,
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
