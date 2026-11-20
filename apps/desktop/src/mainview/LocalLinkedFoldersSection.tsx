import { useState } from "react";

import { invoke } from "@tauri-apps/api/core";
import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Separator } from "@stll/ui/separator";
import { TruncatedText } from "@stll/ui/truncated-text";

import { useNativeStatus } from "./AgentSubscriptionsSection";
import {
  isLinkedFolderList,
  linkedFolderNotice,
  LOCAL_LINKED_FOLDERS_CHANGED_EVENT,
} from "./local-linked-folders-status";
import type { LinkedFolderNotice } from "./local-linked-folders-status";

const readLinkedFolders = async () =>
  invoke<unknown>("local_linked_folders_get");

/**
 * The folders on this computer a chat's local runs can work in. A folder
 * stays where it is, and its path never leaves the computer: a chat knows it
 * only by its name. It renders nothing unless the local agents feature is
 * on: the read command refuses otherwise.
 */
export const LocalLinkedFoldersSection = ({
  renderGroup,
}: {
  renderGroup: (content: React.JSX.Element) => React.JSX.Element;
}) => {
  const t = useTranslations("localLinkedFolders");
  const [folders, refresh] = useNativeStatus({
    read: readLinkedFolders,
    event: LOCAL_LINKED_FOLDERS_CHANGED_EVENT,
    isStatus: isLinkedFolderList,
  });
  const [notice, setNotice] = useState<LinkedFolderNotice | null>(null);
  const [picking, setPicking] = useState(false);

  if (folders === null) {
    return null;
  }

  const send = async (command: () => Promise<unknown>) => {
    setNotice(null);
    const result = await Result.tryPromise(command);
    if (Result.isError(result)) {
      setNotice(linkedFolderNotice(result.error.cause));
    }
    // Shown at once, without waiting for the change event.
    refresh();
  };

  return renderGroup(
    <div className="flex flex-col gap-3 px-4 py-3">
      <div className="flex items-center justify-between gap-4">
        <p className="text-muted-foreground min-w-0 flex-1 text-sm leading-relaxed">
          {t("description")}
        </p>
        <Button
          disabled={picking}
          onClick={() => {
            setPicking(true);
            void send(async () => invoke("local_linked_folders_pick")).then(
              () => {
                setPicking(false);
                return undefined;
              },
            );
          }}
          size="sm"
          variant="outline"
        >
          {t("add")}
        </Button>
      </div>
      {notice === null ? null : (
        <p className="text-destructive text-sm" role="alert">
          {t(`notice.${notice}`)}
        </p>
      )}
      {folders.length === 0 ? null : <Separator />}
      {folders.map(({ id, name, path, state }) => (
        <div className="flex items-center justify-between gap-4" key={id}>
          <div className="min-w-0 flex-1">
            <TruncatedText className="text-sm font-medium" render={<p />}>
              {name}
            </TruncatedText>
            <p className="text-muted-foreground text-xs break-all">{path}</p>
            {state === "available" ? null : (
              <p className="text-destructive text-xs">{t(`state.${state}`)}</p>
            )}
          </div>
          <Button
            aria-label={t("removeFolder", { name })}
            onClick={() => {
              void send(async () =>
                invoke("local_linked_folders_remove", { id }),
              );
            }}
            size="sm"
            variant="ghost"
          >
            {t("remove")}
          </Button>
        </div>
      ))}
    </div>,
  );
};
