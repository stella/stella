import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";

import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  ExternalLinkIcon,
  FileTextIcon,
  InfoIcon,
  MailPlusIcon,
  RefreshCcwIcon,
  SaveIcon,
  ShieldCheckIcon,
  Wand2Icon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { readWorkspaces, saveEmailToMatter } from "@/api";
import { buildReplyDraft, buildSummary, runDraftChecks } from "@/checks";
import { env } from "@/env";
import { downloadAttachment, loadMailSnapshot, placeDraft } from "@/outlook";
import type { DraftPlacement } from "@/outlook";
import type {
  AttachmentDownloadResult,
  DraftCheck,
  MailSnapshot,
  OutlookAttachment,
  WorkspaceSummary,
} from "@/types";

type LoadState =
  | { type: "loading" }
  | {
      snapshot: MailSnapshot;
      type: "ready";
    }
  | {
      message: string;
      type: "error";
    };

type SaveState =
  | { type: "idle" }
  | { type: "saving" }
  | {
      attachmentCount: number;
      skippedAttachments: string[];
      type: "saved";
    }
  | {
      message: string;
      type: "error";
    };

export const App = () => {
  const t = useTranslations("outlook");
  const [loadState, setLoadState] = useState<LoadState>({ type: "loading" });
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [workspaceQuery, setWorkspaceQuery] = useState("");
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(
    null,
  );
  const [selectedAttachmentIds, setSelectedAttachmentIds] = useState<
    Set<string>
  >(() => new Set());
  const [summary, setSummary] = useState("");
  const [draftIntent, setDraftIntent] = useState("");
  const [draft, setDraft] = useState("");
  const [draftPlacement, setDraftPlacement] = useState<DraftPlacement | null>(
    null,
  );
  const [checks, setChecks] = useState<DraftCheck[]>([]);
  const [saveState, setSaveState] = useState<SaveState>({ type: "idle" });

  const refreshSnapshot = useCallback(async () => {
    setLoadState({ type: "loading" });
    try {
      const snapshot = await loadMailSnapshot();
      setLoadState({ snapshot, type: "ready" });
      setSelectedAttachmentIds(
        new Set(
          snapshot.attachments
            .filter((attachment) => !attachment.isInline)
            .map((attachment) => attachment.id),
        ),
      );
      setSummary(buildSummary(snapshot));
      setDraft(buildReplyDraft({ intent: "", snapshot }));
      setChecks(runDraftChecks({ selectedWorkspaceId: null, snapshot }));
      setSaveState({ type: "idle" });
    } catch (error) {
      setLoadState({
        message: error instanceof Error ? error.message : t("loadError"),
        type: "error",
      });
    }
  }, [t]);

  useEffect(() => {
    void refreshSnapshot();
  }, [refreshSnapshot]);

  useEffect(() => {
    readWorkspaces()
      .then((result) => {
        setWorkspaces(result);
        setWorkspaceError(null);
        return undefined;
      })
      .catch((error: unknown) => {
        setWorkspaceError(
          error instanceof Error ? error.message : t("matterLoadError"),
        );
        return undefined;
      });
  }, [t]);

  const snapshot = loadState.type === "ready" ? loadState.snapshot : null;

  useEffect(() => {
    if (!snapshot) {
      return;
    }
    setChecks(runDraftChecks({ selectedWorkspaceId, snapshot }));
  }, [selectedWorkspaceId, snapshot]);

  const suggestedWorkspaceId = snapshot
    ? suggestWorkspaceId({ snapshot, workspaces })
    : null;

  useEffect(() => {
    if (!selectedWorkspaceId && suggestedWorkspaceId) {
      setSelectedWorkspaceId(suggestedWorkspaceId);
    }
  }, [selectedWorkspaceId, suggestedWorkspaceId]);

  const filteredWorkspaces = filterWorkspaces({
    query: workspaceQuery,
    workspaces,
  });
  const selectedWorkspace =
    workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ??
    null;

  const handleCheckDraft = () => {
    if (!snapshot) {
      return;
    }
    setChecks(runDraftChecks({ selectedWorkspaceId, snapshot }));
  };

  const handleDraft = () => {
    if (!snapshot) {
      return;
    }
    setDraft(buildReplyDraft({ intent: draftIntent, snapshot }));
    setDraftPlacement(null);
  };

  const handlePlaceDraft = async () => {
    if (!draft) {
      return;
    }
    const placement = await placeDraft(draft);
    setDraftPlacement(placement);
  };

  const handleSave = async () => {
    if (!snapshot || !selectedWorkspaceId) {
      return;
    }

    setSaveState({ type: "saving" });
    try {
      const selectedAttachments = snapshot.attachments.filter((attachment) =>
        selectedAttachmentIds.has(attachment.id),
      );
      const attachmentResults: AttachmentDownloadResult[] = [];
      for (const attachment of selectedAttachments) {
        attachmentResults.push(await downloadAttachment(attachment));
      }
      const result = await saveEmailToMatter({
        attachmentResults,
        snapshot,
        workspaceId: selectedWorkspaceId,
      });
      setSaveState({
        attachmentCount: result.attachmentCount,
        skippedAttachments: result.skippedAttachments,
        type: "saved",
      });
    } catch (error) {
      setSaveState({
        message:
          error instanceof Error ? error.message : t("saveErrorFallback"),
        type: "error",
      });
    }
  };

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand-block">
          <span className="brand-mark" aria-hidden="true">
            §
          </span>
          <div className="brand-copy">
            <h1>{t("stellaForOutlook")}</h1>
            {snapshot && <p>{modeLabel(snapshot.mode, t)}</p>}
          </div>
        </div>
        <button
          aria-label={t("refresh")}
          className="icon-button"
          onClick={() => void refreshSnapshot()}
          type="button"
        >
          <RefreshCcwIcon />
        </button>
      </header>

      <div className="pane-stack">
        {loadState.type === "loading" && <LoadingState label={t("loading")} />}
        {loadState.type === "error" && (
          <Notice tone="risk" title={t("loadError")}>
            {loadState.message}
          </Notice>
        )}
        {snapshot && (
          <>
            <EmailSnapshotPanel snapshot={snapshot} t={t} />
            <MatterPanel
              filteredWorkspaces={filteredWorkspaces}
              onQueryChange={setWorkspaceQuery}
              onSelect={setSelectedWorkspaceId}
              query={workspaceQuery}
              selectedWorkspaceId={selectedWorkspaceId}
              suggestedWorkspaceId={suggestedWorkspaceId}
              t={t}
              workspaceError={workspaceError}
            />
            <ActionPanel
              checks={checks}
              draft={draft}
              draftIntent={draftIntent}
              draftPlacement={draftPlacement}
              onCheckDraft={handleCheckDraft}
              onDraft={handleDraft}
              onDraftChange={setDraft}
              onIntentChange={setDraftIntent}
              onPlaceDraft={() => void handlePlaceDraft()}
              onSummary={() => setSummary(buildSummary(snapshot))}
              summary={summary}
              t={t}
            />
            <SavePanel
              attachments={snapshot.attachments}
              onSave={() => void handleSave()}
              onToggleAttachment={(attachmentId) =>
                setSelectedAttachmentIds((current) => {
                  const next = new Set(current);
                  if (next.has(attachmentId)) {
                    next.delete(attachmentId);
                  } else {
                    next.add(attachmentId);
                  }
                  return next;
                })
              }
              saveState={saveState}
              selectedAttachmentIds={selectedAttachmentIds}
              selectedWorkspace={selectedWorkspace}
              t={t}
            />
          </>
        )}
      </div>
    </div>
  );
};

type Translate = ReturnType<typeof useTranslations<"outlook">>;

const LoadingState = ({ label }: { label: string }) => (
  <div className="loading-row">
    <RefreshCcwIcon className="spin" />
    {label}
  </div>
);

const EmailSnapshotPanel = ({
  snapshot,
  t,
}: {
  snapshot: MailSnapshot;
  t: Translate;
}) => (
  <section className="panel">
    <div className="section-heading">
      <MailPlusIcon />
      <div className="heading-copy">
        <h2>{snapshot.subject || t("subjectFallback")}</h2>
        <p>
          {snapshot.from
            ? `${snapshot.from.name || snapshot.from.email} · ${formatDate(snapshot.sentAt)}`
            : formatDate(snapshot.sentAt)}
        </p>
      </div>
    </div>
    <div className="body-preview">{snapshot.bodyText || t("noBody")}</div>
  </section>
);

const MatterPanel = ({
  filteredWorkspaces,
  onQueryChange,
  onSelect,
  query,
  selectedWorkspaceId,
  suggestedWorkspaceId,
  t,
  workspaceError,
}: {
  filteredWorkspaces: WorkspaceSummary[];
  onQueryChange: (value: string) => void;
  onSelect: (workspaceId: string) => void;
  query: string;
  selectedWorkspaceId: string | null;
  suggestedWorkspaceId: string | null;
  t: Translate;
  workspaceError: string | null;
}) => (
  <section className="panel">
    <PanelTitle icon={<FileTextIcon />} title={t("chooseMatter")} />
    {workspaceError && (
      <Notice tone="warning" title={workspaceError}>
        <a
          className="inline-link"
          href={env.stellaWebUrl}
          rel="noreferrer"
          target="_blank"
        >
          {t("openStella")}
          <ExternalLinkIcon />
        </a>
        <span> {t("signInHint")}</span>
      </Notice>
    )}
    <input
      aria-label={t("matterSearch")}
      className="text-input"
      onChange={(event) => onQueryChange(event.currentTarget.value)}
      placeholder={t("matterSearch")}
      type="search"
      value={query}
    />
    <div className="matter-list">
      {filteredWorkspaces.length === 0 && (
        <p className="empty-text">{t("noMatterResults")}</p>
      )}
      {filteredWorkspaces.slice(0, 12).map((workspace) => (
        <button
          className={classNames(
            "matter-option",
            selectedWorkspaceId === workspace.id && "matter-option-selected",
          )}
          key={workspace.id}
          onClick={() => onSelect(workspace.id)}
          type="button"
        >
          <span className="matter-copy">
            <span className="matter-name">{workspace.name}</span>
            <span className="matter-meta">
              {[workspace.reference, workspace.clientName]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </span>
          {workspace.id === suggestedWorkspaceId && (
            <span className="suggestion-chip">{t("suggested")}</span>
          )}
        </button>
      ))}
    </div>
  </section>
);

const ActionPanel = ({
  checks,
  draft,
  draftIntent,
  draftPlacement,
  onCheckDraft,
  onDraft,
  onDraftChange,
  onIntentChange,
  onPlaceDraft,
  onSummary,
  summary,
  t,
}: {
  checks: DraftCheck[];
  draft: string;
  draftIntent: string;
  draftPlacement: DraftPlacement | null;
  onCheckDraft: () => void;
  onDraft: () => void;
  onDraftChange: (value: string) => void;
  onIntentChange: (value: string) => void;
  onPlaceDraft: () => void;
  onSummary: () => void;
  summary: string;
  t: Translate;
}) => (
  <section className="panel">
    <div className="action-grid">
      <button
        className="button button-outline"
        onClick={onSummary}
        type="button"
      >
        <FileTextIcon />
        {t("summarize")}
      </button>
      <button className="button button-outline" onClick={onDraft} type="button">
        <Wand2Icon />
        {t("draftReply")}
      </button>
      <button
        className="button button-outline"
        onClick={onCheckDraft}
        type="button"
      >
        <ShieldCheckIcon />
        {t("checkDraft")}
      </button>
    </div>

    <OutputBlock icon={<FileTextIcon />} title={t("summary")} value={summary} />

    <div className="field-stack">
      <PanelTitle icon={<Wand2Icon />} title={t("draftReply")} />
      <textarea
        className="textarea"
        onChange={(event) => onIntentChange(event.currentTarget.value)}
        placeholder={t("draftIntentPlaceholder")}
        value={draftIntent}
      />
      <textarea
        aria-label={t("draftReply")}
        className="textarea textarea-tall"
        onChange={(event) => onDraftChange(event.currentTarget.value)}
        value={draft}
      />
      <div className="inline-actions">
        <button
          className="button button-primary"
          disabled={!draft}
          onClick={onPlaceDraft}
          type="button"
        >
          <MailPlusIcon />
          {t("copyOrInsertDraft")}
        </button>
        {draftPlacement && (
          <span className="muted-text">
            {placementLabel(draftPlacement, t)}
          </span>
        )}
      </div>
    </div>

    <div className="field-stack">
      <PanelTitle icon={<ShieldCheckIcon />} title={t("checked")} />
      <div className="check-list">
        {checks.map((check) => (
          <CheckRow check={check} key={`${check.type}-${check.title}`} />
        ))}
      </div>
    </div>
  </section>
);

const SavePanel = ({
  attachments,
  onSave,
  onToggleAttachment,
  saveState,
  selectedAttachmentIds,
  selectedWorkspace,
  t,
}: {
  attachments: OutlookAttachment[];
  onSave: () => void;
  onToggleAttachment: (attachmentId: string) => void;
  saveState: SaveState;
  selectedAttachmentIds: Set<string>;
  selectedWorkspace: WorkspaceSummary | null;
  t: Translate;
}) => {
  const visibleAttachments = attachments.filter(
    (attachment) => !attachment.isInline,
  );
  const saveLabel = selectedWorkspace
    ? t("saveButtonLabel", { matterName: selectedWorkspace.name })
    : t("chooseMatter");

  return (
    <section className="panel save-panel">
      <PanelTitle icon={<SaveIcon />} title={t("saveEmail")} />
      <div className="field-stack">
        <p className="muted-text">{t("attachmentSelection")}</p>
        {visibleAttachments.length === 0 && (
          <p className="muted-text">{t("noAttachments")}</p>
        )}
        {visibleAttachments.map((attachment) => (
          <label className="attachment-row" key={attachment.id}>
            <input
              checked={selectedAttachmentIds.has(attachment.id)}
              onChange={() => onToggleAttachment(attachment.id)}
              type="checkbox"
            />
            <span className="attachment-name">{attachment.name}</span>
            <span className="attachment-size">
              {formatBytes(attachment.size)}
            </span>
          </label>
        ))}
      </div>
      <button
        className="button button-primary full-width"
        disabled={!selectedWorkspace || saveState.type === "saving"}
        onClick={onSave}
        type="button"
      >
        <SaveIcon />
        {saveState.type === "saving" ? t("saving") : saveLabel}
      </button>
      {saveState.type === "saved" && (
        <Notice tone="success" title={t("saveSuccess")}>
          {t("attachmentsSaved", { count: saveState.attachmentCount })}
          {saveState.skippedAttachments.length > 0 && (
            <span className="notice-detail">
              {t("attachmentsSkipped")}:{" "}
              {saveState.skippedAttachments.join("; ")}
            </span>
          )}
        </Notice>
      )}
      {saveState.type === "error" && (
        <Notice tone="risk" title={t("saveFailed")}>
          {saveState.message}
        </Notice>
      )}
    </section>
  );
};

const PanelTitle = ({ icon, title }: { icon: ReactNode; title: string }) => (
  <div className="panel-title">
    <span className="panel-title-icon">{icon}</span>
    <h2>{title}</h2>
  </div>
);

const OutputBlock = ({
  icon,
  title,
  value,
}: {
  icon: ReactNode;
  title: string;
  value: string;
}) => (
  <div className="field-stack">
    <PanelTitle icon={icon} title={title} />
    <pre className="output-block">{value}</pre>
  </div>
);

const CheckRow = ({ check }: { check: DraftCheck }) => (
  <div className={classNames("check-row", `check-row-${check.type}`)}>
    <span className="check-icon">
      {check.type === "info" ? <InfoIcon /> : <AlertTriangleIcon />}
    </span>
    <span className="check-copy">
      <span className="check-title">{check.title}</span>
      <span className="check-description">{check.description}</span>
    </span>
  </div>
);

const Notice = ({
  children,
  title,
  tone,
}: {
  children: ReactNode;
  title: string;
  tone: "risk" | "success" | "warning";
}) => (
  <div className={classNames("notice", `notice-${tone}`)}>
    <div className="notice-title">
      {tone === "success" ? <CheckCircle2Icon /> : <AlertTriangleIcon />}
      {title}
    </div>
    <div className="notice-copy">{children}</div>
  </div>
);

const filterWorkspaces = ({
  query,
  workspaces,
}: {
  query: string;
  workspaces: WorkspaceSummary[];
}) => {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length === 0) {
    return workspaces;
  }

  return workspaces.filter((workspace) => {
    const haystack = [workspace.name, workspace.reference, workspace.clientName]
      .filter((value): value is string => !!value)
      .join(" ")
      .toLowerCase();
    return haystack.includes(normalizedQuery);
  });
};

const suggestWorkspaceId = ({
  snapshot,
  workspaces,
}: {
  snapshot: MailSnapshot;
  workspaces: WorkspaceSummary[];
}): string | null => {
  const haystack = [
    snapshot.subject,
    snapshot.bodyText,
    snapshot.from?.email,
    ...snapshot.attachments.map((attachment) => attachment.name),
  ]
    .filter((value): value is string => !!value)
    .join(" ")
    .toLowerCase();

  let best: { score: number; workspaceId: string } | null = null;
  for (const workspace of workspaces) {
    const terms = [workspace.name, workspace.reference, workspace.clientName]
      .filter((value): value is string => !!value)
      .flatMap((value) => value.toLowerCase().split(/[\s/._-]+/u))
      .filter((term) => term.length >= 3);
    const score = terms.reduce(
      (total, term) => total + (haystack.includes(term) ? 1 : 0),
      0,
    );
    if (score > 0 && (!best || score > best.score)) {
      best = { score, workspaceId: workspace.id };
    }
  }

  return best?.workspaceId ?? workspaces.at(0)?.id ?? null;
};

const modeLabel = (mode: MailSnapshot["mode"], t: Translate): string => {
  if (mode === "compose") {
    return t("composeMode");
  }
  if (mode === "read") {
    return t("readMode");
  }
  return t("browserMode");
};

const placementLabel = (placement: DraftPlacement, t: Translate): string => {
  if (placement === "composeBody") {
    return t("insertedIntoDraft");
  }
  if (placement === "replyForm") {
    return t("openedReplyDraft");
  }
  return t("copiedToClipboard");
};

const formatDate = (value: string | null): string => {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
};

const formatBytes = (value: number | null): string => {
  if (value === null) {
    return "";
  }
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${Math.round(value / 1024)} KB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
};

const classNames = (...values: (false | string | undefined)[]) =>
  values
    .filter((value): value is string => typeof value === "string")
    .join(" ");
