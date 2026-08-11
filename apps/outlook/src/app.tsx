import { useEffect, useState } from "react";

import { RefreshCcwIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";

import { runDraftChecks } from "@/checks";
import { ActionPanel } from "@/components/action-panel";
import { AppHeader } from "@/components/app-header";
import { EmailSnapshotPanel } from "@/components/email-snapshot-panel";
import { MatterPanel } from "@/components/matter-panel";
import { Notice } from "@/components/notice";
import type { Translate } from "@/components/panel";
import { SavePanel } from "@/components/save-panel";
import { SignInPanel } from "@/components/sign-in-panel";
import type { SignInState } from "@/components/sign-in-panel";
import { env } from "@/env";
import { useAIDraft } from "@/hooks/use-ai-draft";
import { useAISummary } from "@/hooks/use-ai-summary";
import { useIngestEmail } from "@/hooks/use-ingest-email";
import { useMailSnapshot } from "@/hooks/use-mail-snapshot";
import { useWorkspaceSelection } from "@/hooks/use-workspace-selection";
import { useWorkspaces } from "@/hooks/use-workspaces";
import { getAuthToken, signInViaDialog, subscribeAuthToken } from "@/lib/auth";
import { placeDraft } from "@/outlook";
import type { DraftPlacement } from "@/outlook";
import type { MailSnapshot } from "@/types";

export const App = () => {
  const t = useTranslations("outlook");
  const [token, setToken] = useState<string | null>(() => getAuthToken());
  const [signInState, setSignInState] = useState<SignInState>({ type: "idle" });

  useEffect(() => subscribeAuthToken(setToken), []);

  const handleSignIn = () => {
    setSignInState({ type: "signing-in" });
    signInViaDialog({
      signInOrigin: env.signInOrigin,
      taskpaneOrigin: env.taskpaneOrigin,
    })
      .then(() => setSignInState({ type: "idle" }))
      .catch((error: unknown) => {
        setSignInState({
          message: error instanceof Error ? error.message : t("loadError"),
          type: "error",
        });
      });
  };

  if (!token) {
    return (
      <SignInPanel onSignIn={handleSignIn} signInState={signInState} t={t} />
    );
  }

  return <AuthedApp t={t} />;
};

type AttachmentSelection = {
  ids: Set<string>;
  source: MailSnapshot;
};

type DraftEdit = {
  source: ReturnType<typeof useAIDraft>["state"] | null;
  value: string;
};

type DraftPlacementState =
  | { source: string; type: "placed"; value: DraftPlacement }
  | { message: string; source: string; type: "error" };

const AuthedApp = ({ t }: { t: Translate }) => {
  const { refresh, state: loadState } = useMailSnapshot(t("loadError"));
  const { error: workspaceError, workspaces } = useWorkspaces(
    t("matterLoadError"),
  );

  const snapshot = loadState.type === "ready" ? loadState.snapshot : null;

  return (
    <div className="min-h-screen">
      <AppHeader
        action={
          <Button
            aria-label={t("refresh")}
            onClick={refresh}
            size="icon"
            variant="ghost"
          >
            <RefreshCcwIcon />
          </Button>
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
          <Notice title={t("loadError")} tone="risk">
            {loadState.message}
          </Notice>
        ) : null}
        {snapshot ? (
          <MessageApp
            key={snapshotKey(snapshot)}
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
  snapshot,
  t,
  workspaceError,
  workspaces,
}: {
  snapshot: MailSnapshot;
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
  const ingest = useIngestEmail(t("saveErrorFallback"));

  const [attachmentSelection, setAttachmentSelection] =
    useState<AttachmentSelection | null>(null);
  const [draftIntent, setDraftIntent] = useState("");
  const [draftEdit, setDraftEdit] = useState<DraftEdit | null>(null);
  const [placementState, setPlacementState] =
    useState<DraftPlacementState | null>(null);

  const defaultAttachmentIds = new Set(
    snapshot.attachments
      .filter((attachment) => !attachment.isInline)
      .map((attachment) => attachment.id),
  );
  const selectedAttachmentIds =
    attachmentSelection?.source === snapshot
      ? attachmentSelection.ids
      : defaultAttachmentIds;
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
  const checks = runDraftChecks({ selectedWorkspaceId, snapshot });

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
    ingest.save({
      attachments: snapshot.attachments.filter((attachment) =>
        selectedAttachmentIds.has(attachment.id),
      ),
      snapshot,
      workspaceId: selectedWorkspaceId,
    });
  };

  const toggleAttachment = (attachmentId: string) => {
    const ids = new Set(selectedAttachmentIds);
    if (ids.has(attachmentId)) {
      ids.delete(attachmentId);
    } else {
      ids.add(attachmentId);
    }
    setAttachmentSelection({ ids, source: snapshot });
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
        attachments={snapshot.attachments}
        onSave={handleSave}
        onToggleAttachment={toggleAttachment}
        saveState={ingest.state}
        selectedAttachmentIds={selectedAttachmentIds}
        selectedWorkspace={selectedWorkspace}
        t={t}
      />
    </>
  );
};

const snapshotKey = (snapshot: MailSnapshot): string =>
  snapshot.itemId ??
  snapshot.internetMessageId ??
  snapshot.conversationId ??
  [snapshot.mode, snapshot.subject, snapshot.sentAt].join(":");

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
