import { useState } from "react";

import { invoke } from "@tauri-apps/api/core";
import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Separator } from "@stll/ui/separator";

import { useNativeStatus } from "./AgentSubscriptionsSection";
import {
  isSkillFolderList,
  LOCAL_SKILL_FOLDERS_CHANGED_EVENT,
  skillFolderNotice,
} from "./local-skill-folders-status";
import type { SkillFolderNotice } from "./local-skill-folders-status";

const readSkillFolders = async () => invoke<unknown>("local_skill_folders_get");

/**
 * The skill folders this computer's local runs can use. A folder stays where
 * it is: neither its path nor its contents leave the computer. It renders
 * nothing unless the local agents feature is on: the read command refuses
 * otherwise.
 */
export const LocalSkillFoldersSection = ({
  renderGroup,
}: {
  renderGroup: (content: React.JSX.Element) => React.JSX.Element;
}) => {
  const t = useTranslations("localSkills");
  const [folders, refresh] = useNativeStatus({
    read: readSkillFolders,
    event: LOCAL_SKILL_FOLDERS_CHANGED_EVENT,
    isStatus: isSkillFolderList,
  });
  const [notice, setNotice] = useState<SkillFolderNotice | null>(null);
  const [picking, setPicking] = useState(false);

  if (folders === null) {
    return null;
  }

  const send = async (command: () => Promise<unknown>) => {
    setNotice(null);
    const result = await Result.tryPromise(command);
    if (Result.isError(result)) {
      setNotice(skillFolderNotice(result.error.cause));
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
            void send(async () => invoke("local_skill_folders_pick")).then(
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
      {folders.map(({ path, skillName, problem }) => (
        <div className="flex items-center justify-between gap-4" key={path}>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">
              {skillName ?? t("unusable")}
            </p>
            <p className="text-muted-foreground text-xs break-all">{path}</p>
            {problem === null ? null : (
              <p className="text-destructive text-xs">
                {t(`notice.${problem}`)}
              </p>
            )}
          </div>
          <Button
            aria-label={t("removeFolder", { path })}
            onClick={() => {
              void send(async () =>
                invoke("local_skill_folders_remove", { path }),
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
