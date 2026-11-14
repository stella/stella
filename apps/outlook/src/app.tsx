import { useTranslations } from "use-intl";

import { Skeleton } from "@stll/ui/components/skeleton";

import { AppHeader } from "@/components/app-header";
import { AssistSection } from "@/components/assist-section";
import { FilingSection } from "@/components/filing-section";
import { MailContext } from "@/components/mail-context";
import { Notice } from "@/components/notice";
import type { Translate } from "@/components/panel";
import { SignInPanel } from "@/components/sign-in-panel";
import { useAssist } from "@/hooks/use-assist";
import { useFileEmail } from "@/hooks/use-file-email";
import { useMailSnapshot } from "@/hooks/use-mail-snapshot";
import { useOutlookAuth } from "@/hooks/use-outlook-auth";
import { useWorkspaceSelection } from "@/hooks/use-workspace-selection";
import { useWorkspaces } from "@/hooks/use-workspaces";
import type { MailSnapshot } from "@/types";

export const App = () => {
  const t = useTranslations("outlook");
  const { signIn, signInState, signOut, status } = useOutlookAuth();

  if (status === "signed-out") {
    return <SignInPanel onSignIn={signIn} signInState={signInState} t={t} />;
  }

  return <AuthedApp onSignOut={signOut} t={t} />;
};

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
      <AppHeader onRefresh={refresh} onSignOut={onSignOut} />
      <div className="flex flex-col gap-6 px-3 pt-1 pb-6">
        {loadState.type === "loading" ? <PaneSkeleton t={t} /> : null}
        {loadState.type === "error" ? (
          <Notice role="alert" title={t("loadError")} tone="risk">
            {loadState.message}
          </Notice>
        ) : null}
        {snapshot ? (
          <MessageApp
            isCurrent={isCurrent}
            key={snapshot.itemInstanceKey}
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

/** The signed-in pane's shape while the email loads: context, then a matter row. */
const PaneSkeleton = ({ t }: { t: Translate }) => (
  <div aria-label={t("loading")} className="flex flex-col gap-6" role="status">
    <div className="flex flex-col gap-1.5 px-1">
      <Skeleton className="h-4 w-4/5" />
      <Skeleton className="h-3 w-1/2" />
    </div>
    <div className="flex flex-col gap-2">
      <Skeleton className="mx-1 h-3.5 w-16" />
      <Skeleton className="h-15 w-full rounded-xl" />
      <Skeleton className="h-10 w-full rounded-lg" />
    </div>
  </div>
);

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
    setQuery,
    setSelectedWorkspaceId,
    suggestedWorkspaceId,
  } = useWorkspaceSelection({ snapshot, workspaces });
  const suggestedWorkspace =
    workspaces.find((workspace) => workspace.id === suggestedWorkspaceId) ??
    null;
  // The matter in view: the one chosen, else the one the email points to.
  // Filing still waits for the user's click on it.
  const target = selectedWorkspace ?? suggestedWorkspace;

  const assist = useAssist(t("aiErrorFallback"));
  const fileEmail = useFileEmail({
    attachmentError: t("attachmentReadError"),
    errorFallback: t("saveErrorFallback"),
    itemChanged: t("itemChanged"),
    noFileColumn: t("noFileColumn"),
    notFinalized: t("saveNotFinalized"),
    tooLarge: t("emailTooLarge"),
  });

  return (
    <>
      <MailContext snapshot={snapshot} t={t} />
      <FilingSection
        matches={filteredWorkspaces}
        onChoose={setSelectedWorkspaceId}
        onFile={(workspace) =>
          fileEmail.save({
            isCurrent,
            loadLatest,
            snapshot,
            workspace,
          })
        }
        onQueryChange={setQuery}
        query={query}
        saveState={fileEmail.state}
        t={t}
        target={target}
        targetIsSuggestion={
          selectedWorkspace === null && suggestedWorkspace !== null
        }
        workspaceError={workspaceError}
      />
      <AssistSection
        isBusy={assist.isBusy}
        matter={target}
        onAsk={({ instruction, kind, prompt }) =>
          assist.ask({
            instruction,
            kind,
            prompt,
            snapshot,
            workspaceId: target?.id ?? null,
          })
        }
        onRetry={(turnId) =>
          assist.retry(turnId, { snapshot, workspaceId: target?.id ?? null })
        }
        snapshot={snapshot}
        t={t}
        turns={assist.turns}
      />
    </>
  );
};
