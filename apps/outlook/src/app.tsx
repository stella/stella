import { useState } from "react";

import { useTranslations } from "use-intl";

import { toSafeId } from "@stll/api-contract/safe-id";
import { Button } from "@stll/ui/components/button";
import { LogOutIcon, RefreshCcwIcon } from "@stll/ui/icons";

import { runDraftChecks } from "@/checks";
import { ActionPanel } from "@/components/action-panel";
import { AppHeader } from "@/components/app-header";
import { EmailSnapshotPanel } from "@/components/email-snapshot-panel";
import { MatterPanel } from "@/components/matter-panel";
import { Notice } from "@/components/notice";
import type { Translate } from "@/components/panel";
import { SavePanel } from "@/components/save-panel";
import { SignInPanel } from "@/components/sign-in-panel";
import { useAIDraft } from "@/hooks/use-ai-draft";
import { useAISummary } from "@/hooks/use-ai-summary";
import { useFileEmail } from "@/hooks/use-file-email";
import { useMailSnapshot } from "@/hooks/use-mail-snapshot";
import { useOutlookAuth } from "@/hooks/use-outlook-auth";
import { useWorkspaceSelection } from "@/hooks/use-workspace-selection";
import { useWorkspaces } from "@/hooks/use-workspaces";
import { placeDraft } from "@/outlook";
import type { DraftPlacement } from "@/outlook";
import type { MailSnapshot } from "@/types";

export const App = () => {
  const t = useTranslations("outlook");
  const { signIn, signInState, signOut, status } = useOutlookAuth();

  if (status === "signed-out") {
    return <SignInPanel onSignIn={signIn} signInState={signInState} t={t} />;
  }

  return <AuthedApp onSignOut={signOut} t={t} />;
};

type DraftEdit = {
  source: ReturnType<typeof useAIDraft>["state"] | null;
  value: string;
};

type DraftPlacementState =
  | { source: string; type: "placed"; value: DraftPlacement }
  | { message: string; source: string; type: "error" };

const AuthedApp = ({
  onSignOut,
  t,
}: {
  onSignOut: () => void;
  t: Translate;
}) => {
  const {
    isCurrent,
    loadLatest,
    refresh,
    state: loadState,
  } = useMailSnapshot({
    attachmentErrorFallback: t("attachmentReadError"),
    errorFallback: t("loadError"),
  });
  const { error: workspaceError, workspaces } = useWorkspaces(
    t("matterLoadError"),
  );

  const snapshot = loadState.type === "ready" ? loadState.snapshot : null;

  return (
    <div className="min-h-dvh">
      <AppHeader
        action={
          <div className="flex items-center gap-1">
            <Button
              aria-label={t("refresh")}
              onClick={refresh}
              size="icon"
              variant="ghost"
            >
              <RefreshCcwIcon />
            </Button>
            <Button
              aria-label={t("signOut")}
              onClick={onSignOut}
              size="icon"
              variant="ghost"
            >
              <LogOutIcon />
            </Button>
          </div>
        }
        subtitle={snapshot ? modeLabel(snapshot.mode, t) : undefined}
        title={t("stellaForOutlook")}
      />

      <div className="flex flex-col gap-4 p-4">
        {loadState.type === "loading" ? (
          <div className="bg-muted/40 border-border flex items-center gap-2 rounded-lg border px-3 py-2.5 text-sm">
            <RefreshCcwIcon className="size-4 animate-spin" />
            {t("loading")}
          </div>
        ) : null}
        {loadState.type === "error" ? (
          <Notice role="alert" title={t("loadError")} tone="risk">
            {loadState.message}
          </Notice>
        ) : null}
        {snapshot ? (
          <MessageApp
            isCurrent={isCurrent}
            key={snapshotKey(snapshot)}
            loadLatest={loadLatest}
            snapshot={snapshot}
            t={t}
            workspaceError={workspaceError}
            workspaces={workspaces}
          />
        ) : null}
      </div>
    </div>
  );
};

const MessageApp = ({
  isCurrent,
  snapshot,
  loadLatest,
  t,
  workspaceError,
  workspaces,
}: {
  isCurrent: (itemInstanceKey: string) => boolean;
  snapshot: MailSnapshot;
  loadLatest: () => Promise<MailSnapshot>;
  t: Translate;
  workspaceError: string | null;
  workspaces: ReturnType<typeof useWorkspaces>["workspaces"];
}) => {
  const {
    filteredWorkspaces,
    query,
    selectedWorkspace,
    selectedWorkspaceId,
    setQuery,
    setSelectedWorkspaceId,
    suggestedWorkspaceId,
  } = useWorkspaceSelection({ snapshot, workspaces });

  const summary = useAISummary(t("saveErrorFallback"));
  const aiDraft = useAIDraft(t("saveErrorFallback"));
  const fileEmail = useFileEmail({
    attachmentError: t("attachmentReadError"),
    errorFallback: t("saveErrorFallback"),
    itemChanged: t("itemChanged"),
    noFileColumn: t("noFileColumn"),
    notFinalized: t("saveNotFinalized"),
    tooLarge: t("emailTooLarge"),
  });

  const [draftIntent, setDraftIntent] = useState("");
  const [draftEdit, setDraftEdit] = useState<DraftEdit | null>(null);
  const [placementState, setPlacementState] =
    useState<DraftPlacementState | null>(null);

  const draftSource = aiDraft.state.type === "ready" ? aiDraft.state : null;
  const draft =
    draftEdit?.source === draftSource
      ? draftEdit.value
      : (draftSource?.draft ?? "");
  const draftPlacement =
    placementState?.source === draft && placementState.type === "placed"
      ? placementState.value
      : null;
  const draftPlacementError =
    placementState?.source === draft && placementState.type === "error"
      ? placementState.message
      : null;
  const checks = runDraftChecks({ selectedWorkspaceId, snapshot, t });

  const handlePlaceDraft = () => {
    if (!draft) {
      return;
    }
    placeDraft(draft)
      .then((value) =>
        setPlacementState({ source: draft, type: "placed", value }),
      )
      .catch((error: unknown) => {
        setPlacementState({
          message:
            error instanceof Error ? error.message : t("draftPlacementError"),
          source: draft,
          type: "error",
        });
      });
  };

  const handleSave = () => {
    if (!selectedWorkspaceId) {
      return;
    }
    fileEmail.save({
      isCurrent,
      loadLatest,
      snapshot,
      workspaceId: toSafeId<"workspace">(selectedWorkspaceId),
    });
  };

  return (
    <>
      <EmailSnapshotPanel snapshot={snapshot} t={t} />
      <MatterPanel
        onQueryChange={setQuery}
        onSelect={setSelectedWorkspaceId}
        query={query}
        selectedWorkspaceId={selectedWorkspaceId}
        suggestedWorkspaceId={suggestedWorkspaceId}
        t={t}
        workspaceError={workspaceError}
        workspaces={filteredWorkspaces}
      />
      <ActionPanel
        canSummarize={snapshot.bodyText.trim().length > 0}
        checks={checks}
        draft={draft}
        draftIntent={draftIntent}
        draftPlacement={draftPlacement}
        draftPlacementError={draftPlacementError}
        draftState={aiDraft.state}
        onDraftChange={(value) => setDraftEdit({ source: draftSource, value })}
        onDraftReply={() =>
          aiDraft.draftReply({ intent: draftIntent, snapshot })
        }
        onIntentChange={setDraftIntent}
        onPlaceDraft={handlePlaceDraft}
        onSummarize={() => summary.summarize({ text: snapshot.bodyText })}
        summaryState={summary.state}
        t={t}
      />
      <SavePanel
        onSave={handleSave}
        saveState={fileEmail.state}
        selectedWorkspace={selectedWorkspace}
        t={t}
      />
    </>
  );
};

const snapshotKey = (snapshot: MailSnapshot): string =>
  snapshot.itemInstanceKey;

const modeLabel = (
  mode: "browser" | "compose" | "read",
  t: Translate,
): string => {
  if (mode === "compose") {
    return t("composeMode");
  }
  if (mode === "read") {
    return t("readMode");
  }
  return t("browserMode");
};
