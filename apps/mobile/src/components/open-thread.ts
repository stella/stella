import { useGlobalSearchParams, useRouter, useSegments } from "expo-router";

import { useLayout, useSelection } from "@/components/selection";

/** The thread to open, with what its screen shows before it loads. */
type ThreadToOpen = {
  readonly threadId: string;
  readonly title: string;
  readonly matterId: string | undefined;
};

/** Whether the chats tab is the screen in front, with nothing pushed over it. */
const chatsTabInFront = (segments: readonly string[]) =>
  segments[0] === "(tabs)" && (segments[1] ?? "index") === "index";

/**
 * Opens a thread: beside the chats where the window has two columns, which
 * brings the chats tab to the front, else on its own screen.
 */
export const useOpenThread = (): ((thread: ThreadToOpen) => void) => {
  const router = useRouter();
  const layout = useLayout();
  const selection = useSelection();
  const segments: readonly string[] = useSegments();

  return ({ matterId, threadId, title }) => {
    if (layout.usesSplitView) {
      selection.select("thread", { matterId, threadId, title });
      if (!chatsTabInFront(segments)) {
        router.navigate("/");
      }
      return;
    }
    router.push({
      pathname: "/thread/[threadId]",
      params: {
        threadId,
        title,
        ...(matterId === undefined ? {} : { matterId }),
      },
    });
  };
};

/**
 * The thread the person is looking at, if any: the one on its own screen,
 * or the one beside the chats while that tab is in front.
 */
export const useThreadOnScreen = (): string | undefined => {
  const segments: readonly string[] = useSegments();
  const { threadId } = useGlobalSearchParams<{ threadId?: string }>();
  const layout = useLayout();
  const selection = useSelection();
  if (segments[0] === "thread") {
    return threadId;
  }
  return layout.usesSplitView && chatsTabInFront(segments)
    ? selection.thread?.threadId
    : undefined;
};
