import { useRef, useState } from "react";
import type { RefObject } from "react";

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { MarkdownHybridEditor } from "@stll/markdown-editor";
import type { MarkdownHybridEditorHandle } from "@stll/markdown-editor";
import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { Checkbox } from "@stll/ui/checkbox";
import { Field, FieldLabel } from "@stll/ui/field";
import {
  List,
  ListEmpty,
  ListItem,
  ListItemContent,
  ListItemTitle,
} from "@stll/ui/list";
import { ListItemSkeleton } from "@stll/ui/list-shell";
import { SearchField } from "@stll/ui/search-field";
import { SettingsPanel, SettingsSection } from "@stll/ui/settings";
import { Switch } from "@stll/ui/switch";

import { ContactPicker } from "@/components/contact-picker";
import { isSafeMarkdownPreviewImageSrc } from "@/components/markdown-preview.logic";
import { QueryViewFeedback } from "@/components/query-view-feedback";
import { usePermissions } from "@/hooks/use-permissions";
import { api } from "@/lib/api";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { invokeCapability } from "@/lib/capabilities/capability-request";
import { unwrapApiResponse } from "@/lib/errors/api";
import { openIsolatedWindow } from "@/lib/open-isolated-window";
import { queryView } from "@/lib/query-view.logic";
import { toSafeId } from "@/lib/safe-id";
import { useSettingsMutation } from "@/routes/_protected.settings/organization/-hooks/use-settings-mutation";

import {
  BillingDraftsCardFrame,
  BillingDraftsCardPending,
} from "./billing-drafts-card.pending";

/** Placeholder knowledge files while the list loads. */
const KNOWLEDGE_FILE_ROWS_PENDING = [0, 1, 2] as const;

const billingDraftKeys = {
  all: () => ["billing-draft-configuration"] as const,
};
type BillingConfigurationUpdate = Omit<
  NonNullable<
    Parameters<
      (typeof api)["organization-settings"]["billing-drafts"]["post"]
    >[0]
  >,
  "expectedUpdatedAt"
>;
type KnowledgeFile = Extract<
  NonNullable<
    Awaited<
      ReturnType<
        (typeof api)["organization-settings"]["billing-drafts"]["knowledge-files"]["get"]
      >
    >["data"]
  >,
  { items: unknown }
>["items"][number];
type KnowledgeSave = { file: KnowledgeFile; source: string };

export const BillingDraftsCard = () => {
  const t = useTranslations();
  const { activeOrganizationId, id: userId } = useAuthenticatedUser();
  const canEdit = usePermissions({ organizationSettings: ["update"] });
  const [client, setClient] = useState<{
    id: NonNullable<BillingConfigurationUpdate["clientId"]>;
    displayName: string;
  } | null>(null);
  const [search, setSearch] = useState("");
  const [cursor, setCursor] = useState<string | undefined>();
  const [editing, setEditing] = useState<KnowledgeFile | null>(null);
  const editorHandle = useRef<MarkdownHybridEditorHandle>(null);
  const [editorRevision, setEditorRevision] = useState(0);
  const [content, setContent] = useState<string | undefined>();
  const clientId = client?.id;
  const config = useQuery({
    queryKey: [
      ...billingDraftKeys.all(),
      activeOrganizationId,
      userId,
      clientId,
    ],
    queryFn: async ({ signal }) =>
      unwrapApiResponse(
        await api["organization-settings"]["billing-drafts"].get({
          query: clientId ? { clientId } : {},
          fetch: { signal },
        }),
      ),
  });
  const files = useQuery({
    queryKey: [
      ...billingDraftKeys.all(),
      "files",
      activeOrganizationId,
      userId,
      search,
      cursor,
    ],
    queryFn: async ({ signal }) =>
      unwrapApiResponse(
        await api["organization-settings"]["billing-drafts"][
          "knowledge-files"
        ].get({
          query: { query: search, ...(cursor ? { cursor } : {}) },
          fetch: { signal },
        }),
      ),
  });
  const editingId = editing?.id;
  const editor = useQuery({
    queryKey: [
      ...billingDraftKeys.all(),
      "editor",
      activeOrganizationId,
      userId,
      editingId,
    ],
    enabled: editing !== null,
    queryFn: async ({ signal }) => {
      if (!editingId) {
        return panic("Knowledge editor query requires a file");
      }
      const filesRoute =
        api["organization-settings"]["billing-drafts"]["knowledge-files"];
      return unwrapApiResponse(
        await filesRoute({ resourceId: editingId }).get({ fetch: { signal } }),
      );
    },
  });
  const mutation = useSettingsMutation({
    exceptionScope: {
      type: "handler",
      handlerId: "organization-settings.billing-drafts.update",
    },
    mutationFn: async (body: BillingConfigurationUpdate) =>
      await invokeCapability(
        "organization-settings.billing-drafts.update",
        async (request) =>
          unwrapApiResponse(
            await api["organization-settings"]["billing-drafts"].post(
              {
                ...body,
                expectedUpdatedAt:
                  config.data?.updatedAt ??
                  panic("Billing settings must be loaded before updating"),
              },
              request,
            ),
          ),
      ),
    invalidate: billingDraftKeys.all(),
    errorToast: { title: t("errors.actionFailed") },
  });
  const save = useSettingsMutation({
    exceptionScope: {
      type: "handler",
      handlerId: "skills.resources.update",
    },
    mutationFn: async ({ file, source }: KnowledgeSave) =>
      await invokeCapability("skills.resources.update", async (request) =>
        unwrapApiResponse(
          await api
            .skills({ skillId: file.skillId })
            .resources.patch({ path: file.path, content: source }, request),
        ),
      ),
    invalidate: billingDraftKeys.all(),
    errorToast: { title: t("errors.actionFailed") },
    onSuccess: () => setEditing(null),
    onError: () => setEditorRevision((revision) => revision + 1),
  });
  if (config.isError) {
    return (
      <SettingsSection>
        <SettingsPanel>
          <QueryViewFeedback view={queryView(config)} />
        </SettingsPanel>
      </SettingsSection>
    );
  }
  if (!config.data) {
    return <BillingDraftsCardPending />;
  }
  const attachedIds = config.data.files
    .filter((file) => file.clientId === (client?.id ?? null))
    .map((file) => file.fileId);

  const nextCursor = files.data?.nextCursor;
  return (
    <BillingDraftsCardFrame>
      {(files.isError || editor.isError) &&
        (files.isError ? (
          <QueryViewFeedback view={queryView(files)} />
        ) : (
          <QueryViewFeedback view={queryView(editor)} />
        ))}
      <Field className="flex-row items-center gap-2">
        <Switch
          checked={config.data.mode === "enabled"}
          disabled={!canEdit || mutation.isPending}
          onCheckedChange={(enabled) =>
            mutation.mutate({ mode: enabled ? "enabled" : "disabled" })
          }
        />
        <FieldLabel>
          {t("settings.organization.billingDrafts.title")}
        </FieldLabel>
      </Field>
      <div className="flex items-center gap-2">
        <Button
          aria-pressed={client === null}
          type="button"
          variant={client === null ? "secondary" : "outline"}
          onClick={() => setClient(null)}
        >
          {t("settings.organization.billingDrafts.firm")}
        </Button>
        <ContactPicker
          onSelect={(contact) =>
            setClient({
              id: toSafeId<"contact">(contact.id),
              displayName: contact.displayName,
            })
          }
        />
        {client && (
          <span className="text-sm">
            <BidiText>{client.displayName}</BidiText>
          </span>
        )}
      </div>
      {client && (
        <Field className="flex-row items-center gap-2">
          <Switch
            checked={config.data.timeBillingFormat === "ledes"}
            onCheckedChange={(enabled) =>
              mutation.mutate({
                clientId: client.id,
                timeBillingFormat: enabled ? "ledes" : "categories",
              })
            }
            disabled={!canEdit || mutation.isPending}
          />
          <FieldLabel>
            {t("settings.organization.billingDrafts.ledes")}
          </FieldLabel>
        </Field>
      )}
      <Link to="/knowledge/tools" className="text-sm underline">
        {t("navigation.knowledge")}
      </Link>
      <SearchField
        value={search}
        onValueChange={(value) => {
          setSearch(value);
          setCursor(undefined);
        }}
        clearLabel={t("common.reset")}
        placeholder={t("common.search")}
      />
      <List>
        {files.isPending &&
          KNOWLEDGE_FILE_ROWS_PENDING.map((index) => (
            <ListItemSkeleton index={index} key={index} />
          ))}
        {files.data?.items.map((file) => (
          <BillingKnowledgeFileRow
            key={file.id}
            attached={attachedIds.includes(file.id)}
            canEdit={canEdit}
            file={file}
            mutationPending={mutation.isPending}
            savePending={save.isPending}
            onEdit={() => {
              setEditing(file);
              setContent(undefined);
            }}
            onToggle={(attach) => {
              let resourceIds = attachedIds.filter((id) => id !== file.id);
              if (attach) {
                resourceIds = client ? [...attachedIds, file.id] : [file.id];
              }
              mutation.mutate({
                ...(client ? { clientId: client.id } : {}),
                resourceIds,
              });
            }}
          />
        ))}
        {!files.isPending &&
          !files.isError &&
          (files.data?.items.length ?? 0) === 0 && (
            <ListEmpty>
              <span>{t("common.noResults")}</span>
              {search.length > 0 && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setSearch("");
                    setCursor(undefined);
                  }}
                >
                  {t("common.clearSearch")}
                </Button>
              )}
            </ListEmpty>
          )}
      </List>
      {(cursor !== undefined || nextCursor) && (
        <div className="flex items-center gap-2">
          {cursor !== undefined && (
            <Button
              type="button"
              variant="outline"
              onClick={() => setCursor(undefined)}
            >
              {t("common.reset")}
            </Button>
          )}
          {nextCursor && (
            <Button
              type="button"
              variant="outline"
              onClick={() => setCursor(nextCursor)}
            >
              {t("common.next")}
            </Button>
          )}
        </div>
      )}
      {editing && editor.data && (
        <BillingKnowledgeEditor
          canEdit={canEdit}
          content={content ?? editor.data.content}
          editorHandle={editorHandle}
          editorRevision={editorRevision}
          file={editing}
          saving={save.isPending}
          onClose={() => {
            setEditing(null);
            setContent(undefined);
          }}
          onContentChange={setContent}
          onSave={(source) => {
            setContent(source);
            save.mutate({ file: editing, source });
          }}
        />
      )}
    </BillingDraftsCardFrame>
  );
};

type BillingKnowledgeFileRowProps = {
  attached: boolean;
  canEdit: boolean;
  file: KnowledgeFile;
  mutationPending: boolean;
  savePending: boolean;
  onEdit: () => void;
  onToggle: (attach: boolean) => void;
};

const BillingKnowledgeFileRow = ({
  attached,
  canEdit,
  file,
  mutationPending,
  savePending,
  onEdit,
  onToggle,
}: BillingKnowledgeFileRowProps) => {
  const t = useTranslations();
  const disabledReason = canEdit
    ? t("common.saving")
    : t("errors.api.forbidden");

  return (
    <ListItem>
      <Checkbox
        aria-label={file.path}
        checked={attached}
        disabled={!canEdit || mutationPending}
        onCheckedChange={onToggle}
      />
      <ListItemContent>
        <ListItemTitle>
          <BidiText>{file.path}</BidiText>
        </ListItemTitle>
        <p className="text-muted-foreground text-xs">{file.skillName}</p>
      </ListItemContent>
      <Button
        type="button"
        variant="ghost"
        disabled={!canEdit || savePending}
        disabledReason={disabledReason}
        onClick={onEdit}
      >
        {t("common.edit")}
      </Button>
    </ListItem>
  );
};

type BillingKnowledgeEditorProps = {
  canEdit: boolean;
  content: string;
  editorHandle: RefObject<MarkdownHybridEditorHandle | null>;
  editorRevision: number;
  file: KnowledgeFile;
  saving: boolean;
  onClose: () => void;
  onContentChange: (value: string) => void;
  onSave: (source: string) => void;
};

const BillingKnowledgeEditor = ({
  canEdit,
  content,
  editorHandle,
  editorRevision,
  file,
  saving,
  onClose,
  onContentChange,
  onSave,
}: BillingKnowledgeEditorProps) => {
  const t = useTranslations();
  return (
    <div className="flex flex-col gap-3 rounded-md border p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">
          <BidiText>{file.path}</BidiText>
        </span>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          {t("common.close")}
        </Button>
      </div>
      <MarkdownHybridEditor
        ref={editorHandle}
        key={`${file.id}:${editorRevision}`}
        markdown={content}
        onMarkdownChange={onContentChange}
        allowsImageSource={isSafeMarkdownPreviewImageSrc}
        label={t("markdownEditor.rawLabel")}
        onOpenLink={openIsolatedWindow}
      />
      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button
          type="button"
          disabled={!canEdit || saving}
          disabledReason={
            canEdit ? t("common.saving") : t("errors.api.forbidden")
          }
          onClick={() => {
            if (!editorHandle.current) {
              panic("Knowledge editor save requires a mounted editor");
            }
            onSave(editorHandle.current.captureForSave());
          }}
        >
          {t("common.save")}
        </Button>
      </div>
    </div>
  );
};
