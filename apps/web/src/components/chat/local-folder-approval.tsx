import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import type {
  ChatLocalRunFolder,
  ChatLocalRunTarget,
} from "@stll/api-contract/chat-run-target";
import { DESKTOP_RUNNER_LINKED_FOLDER_STATE } from "@stll/api-contract/desktop-runner";
import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { TruncatedText } from "@stll/ui/truncated-text";

import {
  CHAT_LOCAL_HARNESS_NAMES,
  chatLocalFolderOption,
} from "@/components/chat/chat-run-target-menu.logic";
import { localRunnersOptions } from "@/features/chat/queries";
import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { unwrapApiResponse } from "@/lib/errors/api";
import { notifyUserError } from "@/lib/errors/user-toast";
import { useIdempotentMutation } from "@/lib/idempotency/use-idempotent-mutation";
import { queryView } from "@/lib/query-view.logic";

const approveLocalFolder = async ({ desktopId, linkId }: ChatLocalRunFolder) =>
  unwrapApiResponse(
    await api.chat["local-runners"]({ desktopId })
      .folders({ linkId })
      .approval.put(),
  );

/**
 * The OK the member gives before the first turn works in a folder they
 * linked on their computer: shown beside the composer's model while the
 * chat's folder waits for it, and gone once given. The API refuses a turn
 * there until then.
 */
export const LocalFolderApproval = ({
  activeOrganizationId,
  target,
}: {
  activeOrganizationId: string;
  target: ChatLocalRunTarget;
}) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const runners = localRunnersOptions(activeOrganizationId);
  const runnersView = queryView(
    useQuery({ ...runners, enabled: target.folder !== undefined }),
  );
  const approve = useIdempotentMutation({
    idempotencyScope: `chat.local-folder.${target.folder?.linkId ?? "none"}.approve`,
    mutationFn: approveLocalFolder,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: runners.queryKey });
    },
    onError: (error) => {
      getAnalytics().captureError(error, {
        fingerprintKey: "LocalFolderApproval:failure",
        scope: { type: "handler", handlerId: "LocalFolderApproval:failure" },
      });
      notifyUserError(error, t("errors.actionFailed"));
    },
  });
  const { folder } = target;
  if (folder === undefined || runnersView.type !== "items") {
    return null;
  }
  const option = chatLocalFolderOption(runnersView.items, folder);
  if (
    option?.approval !== "pending" ||
    option.state !== DESKTOP_RUNNER_LINKED_FOLDER_STATE.available
  ) {
    return null;
  }
  const explanation = t("chat.localRun.folderApprovalDescription", {
    harness: CHAT_LOCAL_HARNESS_NAMES[target.harness],
    folder: folder.name,
  });
  return (
    <Button
      aria-label={explanation}
      disabled={approve.isPending}
      onClick={() => {
        approve.mutate(folder);
      }}
      size="xs"
      tooltip={explanation}
      variant="outline"
    >
      <TruncatedText className="max-w-36" render={<BidiText as="span" />}>
        {t("chat.localRun.folderApprove", { folder: folder.name })}
      </TruncatedText>
    </Button>
  );
};
