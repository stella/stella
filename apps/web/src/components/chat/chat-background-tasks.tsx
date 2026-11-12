import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { StatusMark } from "@stll/ui/status-mark";

import { Message, MessageContent } from "@/components/ai-elements/message";
import { chatBackgroundTasksOptions } from "@/features/chat/background-tasks";
import { useMaybeAuthenticatedUser } from "@/lib/authenticated-user-context";
import { queryView } from "@/lib/query-view.logic";
import { useQueryViewError } from "@/lib/use-query-view";

const NO_THREAD = { activeOrganizationId: "", userId: "", threadId: "" };

/**
 * What the chat's coding agent left running in the background on the
 * member's computer after its last turn, such as a server or a watcher. The
 * chat's next turn continues where that work runs. Shown between turns
 * only: a running turn holds the work, and nothing shows once it ended or
 * while the computer is away. `ranOnComputer: false` (a chat none of whose
 * turns ran on a computer) reads nothing.
 */
export const ChatBackgroundTasks = ({
  threadId,
  generationActive,
  ranOnComputer = true,
}: {
  threadId: string;
  generationActive: boolean;
  ranOnComputer?: boolean;
}) => {
  const t = useTranslations();
  const user = useMaybeAuthenticatedUser();
  const thread =
    user === null || !ranOnComputer
      ? null
      : {
          activeOrganizationId: user.activeOrganizationId,
          userId: user.id,
          threadId,
        };
  const view = queryView(
    useQuery({
      ...chatBackgroundTasksOptions(thread ?? NO_THREAD),
      enabled: thread !== null,
    }),
  );
  useQueryViewError(view, "ChatBackgroundTasks:query");
  const count = view.type === "items" ? view.items.count : 0;
  if (generationActive || count === 0) {
    return null;
  }
  return (
    <Message from="assistant">
      <MessageContent>
        <div className="text-muted-foreground flex items-center gap-2 text-xs">
          <span className="flex items-center gap-2" role="status">
            <StatusMark status="pending" />
            {t("chat.localRun.backgroundTasks", { count })}
          </span>
        </div>
      </MessageContent>
    </Message>
  );
};
