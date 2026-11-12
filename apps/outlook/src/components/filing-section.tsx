import { useState } from "react";

import { panic } from "better-result";

import { Badge } from "@stll/ui/badge";
import { Button } from "@stll/ui/components/button";
import { ExternalLinkIcon } from "@stll/ui/icons";
import { cn } from "@stll/ui/lib/utils";
import {
  List,
  ListEmpty,
  ListGroupCount,
  ListItem,
  ListItemContent,
  ListItemDescription,
  ListItemMedia,
  ListItemTitle,
} from "@stll/ui/list";
import { MatterIcon } from "@stll/ui/matter-icon";
import { SearchField } from "@stll/ui/search-field";
import { StatusMark } from "@stll/ui/status-mark";

import { Notice } from "@/components/notice";
import { Panel } from "@/components/panel";
import type { Translate } from "@/components/panel";
import { env } from "@/env";
import {
  type FileEmailState,
  isFileEmailActive,
  pendingFinalizeWorkspace,
} from "@/hooks/use-file-email";
import { buildSavedEmailUrl } from "@/lib/saved-email-url";
import type { WorkspaceSummary } from "@/types";

const MAX_VISIBLE_MATTERS = 12;

type FilingSectionProps = {
  matches: WorkspaceSummary[];
  onChoose: (workspaceId: string) => void;
  onFile: (workspace: WorkspaceSummary) => void;
  onQueryChange: (value: string) => void;
  query: string;
  saveState: FileEmailState;
  /** The matter the email goes to: the one chosen, else the suggestion. */
  target: WorkspaceSummary | null;
  targetIsSuggestion: boolean;
  t: Translate;
  workspaceError: string | null;
};

type OpenFilingState = Exclude<FileEmailState, { type: "complete" }>;

/**
 * Filing in one step. With a matter in view (suggested from the email, or
 * chosen) the section is that matter and one button; the full list opens
 * only on "Change". Once filed, it says where.
 */
export const FilingSection = (props: FilingSectionProps) => {
  const { saveState, t } = props;
  switch (saveState.type) {
    case "complete":
      return <FiledPanel saveState={saveState} t={t} />;
    case "error":
    case "idle":
    case "reading":
    case "uploading":
      return <FilingPanel {...props} saveState={saveState} />;
    default:
      saveState satisfies never;
      return panic("Unknown filing state");
  }
};

const FiledPanel = ({
  saveState,
  t,
}: {
  saveState: Extract<FileEmailState, { type: "complete" }>;
  t: Translate;
}) => (
  <Panel
    action={
      <Button
        render={
          <a
            href={buildSavedEmailUrl({
              baseUrl: env.webOrigin,
              entityId: saveState.result.entityId,
              fieldId: saveState.result.fieldId,
              workspaceId: saveState.result.workspaceId,
            })}
            rel="noreferrer"
            target="_blank"
          />
        }
        size="xs"
        variant="ghost"
      >
        {t("openSavedEmail")}
        <ExternalLinkIcon />
      </Button>
    }
    title={t("chooseMatter")}
  >
    <FiledRow saveState={saveState} t={t} />
  </Panel>
);

const fileButtonLabel = (state: OpenFilingState, t: Translate): string => {
  switch (state.type) {
    case "error":
      return state.retry === null ? t("fileEmail") : t("finishSaving");
    case "idle":
    case "reading":
    case "uploading":
      return t("fileEmail");
    default:
      state satisfies never;
      return panic("Unknown filing state");
  }
};

const FilingPanel = ({
  matches,
  onChoose,
  onFile,
  onQueryChange,
  query,
  saveState,
  target,
  targetIsSuggestion,
  t,
  workspaceError,
}: FilingSectionProps & { saveState: OpenFilingState }) => {
  const [picking, setPicking] = useState(false);
  const active = isFileEmailActive(saveState);
  // An upload awaiting confirmation keeps its matter in view until it is
  // finished; filing it elsewhere could leave the email in two matters.
  const pending = pendingFinalizeWorkspace(saveState);
  const shown = pending ?? target;
  const showPicker = shown === null || (picking && pending === null);

  return (
    <Panel
      action={
        shown === null ? undefined : (
          <Button
            disabled={active || pending !== null}
            onClick={() => setPicking(!showPicker)}
            size="xs"
            variant="ghost"
          >
            {showPicker ? t("cancel") : t("changeMatter")}
          </Button>
        )
      }
      title={
        <>
          {t("chooseMatter")}
          {showPicker ? (
            <ListGroupCount
              count={new Intl.NumberFormat().format(matches.length)}
            />
          ) : null}
        </>
      }
    >
      {workspaceError === null ? null : (
        <Notice role="alert" title={workspaceError} tone="warning">
          <Button
            className="mt-1"
            render={<a href={env.webOrigin} rel="noreferrer" target="_blank" />}
            size="xs"
            variant="outline"
          >
            {t("openStella")}
            <ExternalLinkIcon />
          </Button>
        </Notice>
      )}
      {showPicker ? (
        <MatterPicker
          matches={matches}
          onChoose={(workspaceId) => {
            onChoose(workspaceId);
            onQueryChange("");
            setPicking(false);
          }}
          onQueryChange={onQueryChange}
          query={query}
          t={t}
          targetId={shown?.id ?? null}
        />
      ) : (
        <List>
          <ListItem className="px-3">
            <ListItemMedia>
              <MatterIcon matter={{ color: null, id: shown.id }} />
            </ListItemMedia>
            <MatterText
              isSuggested={targetIsSuggestion && pending === null}
              t={t}
              workspace={shown}
            />
          </ListItem>
        </List>
      )}
      {showPicker ? null : (
        <Button
          className="w-full"
          disabled={active}
          loading={active}
          onClick={() => onFile(shown)}
          size="lg"
        >
          {fileButtonLabel(saveState, t)}
        </Button>
      )}
      {saveState.type === "error" ? (
        <Notice role="alert" title={t("saveFailed")} tone="risk">
          {saveState.message}
        </Notice>
      ) : null}
    </Panel>
  );
};

const MatterText = ({
  isSuggested,
  t,
  workspace,
}: {
  isSuggested: boolean;
  t: Translate;
  workspace: WorkspaceSummary;
}) => {
  const meta = [workspace.reference, workspace.clientName]
    .filter(Boolean)
    .join(" · ");
  return (
    <ListItemContent>
      <ListItemTitle>
        <bdi>{workspace.name}</bdi>
      </ListItemTitle>
      {isSuggested || meta ? (
        <ListItemDescription className="flex items-center gap-1.5">
          {isSuggested ? (
            <Badge className="shrink-0" size="xs" tone="success">
              {t("suggested")}
            </Badge>
          ) : null}
          <span className="truncate">
            <bdi>{meta}</bdi>
          </span>
        </ListItemDescription>
      ) : null}
    </ListItemContent>
  );
};

const MatterPicker = ({
  matches,
  onChoose,
  onQueryChange,
  query,
  t,
  targetId,
}: {
  matches: WorkspaceSummary[];
  onChoose: (workspaceId: string) => void;
  onQueryChange: (value: string) => void;
  query: string;
  t: Translate;
  targetId: string | null;
}) => (
  <>
    <SearchField
      aria-label={t("matterSearch")}
      autoFocus={targetId !== null}
      clearLabel={t("clearSearch")}
      onValueChange={onQueryChange}
      placeholder={t("matterSearch")}
      value={query}
    />
    <List className="max-h-72 overflow-y-auto">
      {matches.length === 0 ? (
        <ListEmpty>{t("noMatterResults")}</ListEmpty>
      ) : (
        matches.slice(0, MAX_VISIBLE_MATTERS).map((workspace) => (
          <ListItem
            className={cn(
              "h-auto justify-start rounded-none border-0 px-3 font-normal whitespace-normal before:hidden",
              workspace.id === targetId && "bg-accent hover:bg-accent",
            )}
            key={workspace.id}
            render={
              <Button
                aria-pressed={workspace.id === targetId}
                onClick={() => onChoose(workspace.id)}
                variant="ghost"
              />
            }
          >
            <ListItemMedia>
              <MatterIcon matter={{ color: null, id: workspace.id }} />
            </ListItemMedia>
            <MatterText isSuggested={false} t={t} workspace={workspace} />
          </ListItem>
        ))
      )}
    </List>
    {targetId === null && matches.length > 0 ? (
      <p className="text-muted-foreground px-1 text-xs text-pretty">
        {t("chooseMatterHint")}
      </p>
    ) : null}
  </>
);

const FiledRow = ({
  saveState,
  t,
}: {
  saveState: Extract<FileEmailState, { type: "complete" }>;
  t: Translate;
}) => {
  const notes = [
    saveState.source === "rebuilt" ? t("savedRebuilt") : null,
    saveState.skippedAttachments.length > 0
      ? `${t("attachmentsSkipped")}: ${saveState.skippedAttachments.join("; ")}`
      : null,
  ].filter((note): note is string => note !== null);

  return (
    <div role="status">
      <List>
        <ListItem className="px-3">
          <ListItemMedia className="bg-success/10 text-success-foreground">
            <StatusMark status="done" />
          </ListItemMedia>
          <ListItemContent>
            <ListItemTitle>
              <bdi>{saveState.workspace.name}</bdi>
            </ListItemTitle>
            <ListItemDescription>
              {saveState.skippedAttachments.length > 0
                ? t("filedWithoutSomeAttachments")
                : t("filedDescription")}
            </ListItemDescription>
          </ListItemContent>
        </ListItem>
      </List>
      {notes.map((note) => (
        <p
          className="text-muted-foreground mt-2 px-1 text-xs text-pretty"
          key={note}
        >
          {note}
        </p>
      ))}
    </div>
  );
};
