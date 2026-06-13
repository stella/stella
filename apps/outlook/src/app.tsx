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
import {
  clearAuthToken,
  getAuthToken,
  signInViaDialog,
  subscribeAuthToken,
} from "@/lib/auth";
import { placeDraft } from "@/outlook";
import type { DraftPlacement } from "@/outlook";
import type { DraftCheck } from "@/types";

export const App = () => {
  const t = useTranslations("outlook");
  const [token, setToken] = useState<string | null>(() => getAuthToken());
  const [signInState, setSignInState] = useState<SignInState>({ type: "idle" });

  useEffect(() => subscribeAuthToken(setToken), []);

  const handleSignIn = async () => {
    setSignInState({ type: "signing-in" });
    try {
      await signInViaDialog(env.signInOrigin);
      setSignInState({ type: "idle" });
    } catch (error) {
      setSignInState({
        message: error instanceof Error ? error.message : t("loadError"),
        type: "error",
      });
    }
  };

  if (!token) {
    return (
      <SignInPanel
        onSignIn={() => void handleSignIn()}
        signInState={signInState}
        t={t}
      />
    );
  }

  return <AuthedApp onSignOut={() => void clearAuthToken()} t={t} />;
};

const AuthedApp = ({
  onSignOut: _onSignOut,
  t,
}: {
  onSignOut: () => void;
  t: Translate;
}) => {
  const { refresh, state: loadState } = useMailSnapshot(t("loadError"));
  const { error: workspaceError, workspaces } = useWorkspaces(
    t("matterLoadError"),
  );

  const snapshot = loadState.type === "ready" ? loadState.snapshot : null;

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

  const [selectedAttachmentIds, setSelectedAttachmentIds] = useState<
    Set<string>
  >(() => new Set());
  const [draftIntent, setDraftIntent] = useState("");
  const [draft, setDraft] = useState("");
  const [draftPlacement, setDraftPlacement] = useState<DraftPlacement | null>(
    null,
  );
  const [checks, setChecks] = useState<DraftCheck[]>([]);

  useEffect(() => {
    if (!snapshot) {
      return;
    }
    setSelectedAttachmentIds(
      new Set(
        snapshot.attachments
          .filter((attachment) => !attachment.isInline)
          .map((attachment) => attachment.id),
      ),
    );
  }, [snapshot]);

  useEffect(() => {
    if (!snapshot) {
      return;
    }
    setChecks(runDraftChecks({ selectedWorkspaceId, snapshot }));
  }, [selectedWorkspaceId, snapshot]);

  useEffect(() => {
    if (aiDraft.state.type === "ready") {
      setDraft(aiDraft.state.draft);
      setDraftPlacement(null);
    }
  }, [aiDraft.state]);

  const handlePlaceDraft = async () => {
    if (!draft) {
      return;
    }
    setDraftPlacement(await placeDraft(draft));
  };

  const handleSave = () => {
    if (!snapshot || !selectedWorkspaceId) {
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
    setSelectedAttachmentIds((current) => {
      const next = new Set(current);
      if (next.has(attachmentId)) {
        next.delete(attachmentId);
      } else {
        next.add(attachmentId);
      }
      return next;
    });
  };

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
              checks={checks}
              draft={draft}
              draftIntent={draftIntent}
              draftPlacement={draftPlacement}
              draftState={aiDraft.state}
              onCheckDraft={() =>
                setChecks(runDraftChecks({ selectedWorkspaceId, snapshot }))
              }
              onDraftChange={setDraft}
              onDraftReply={() =>
                aiDraft.draftReply({ intent: draftIntent, snapshot })
              }
              onIntentChange={setDraftIntent}
              onPlaceDraft={() => void handlePlaceDraft()}
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
        ) : null}
      </div>
    </div>
  );
};

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
