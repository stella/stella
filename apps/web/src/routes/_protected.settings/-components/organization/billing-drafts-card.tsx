import { useRef, useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { Checkbox } from "@stll/ui/checkbox";
import { Field, FieldLabel } from "@stll/ui/field";
import { Frame, FramePanel } from "@stll/ui/frame";
import { List, ListItem, ListItemContent, ListItemTitle } from "@stll/ui/list";
import { SearchField } from "@stll/ui/search-field";

import { ContactPicker } from "@/components/contact-picker";
import type { MarkdownHybridEditorHandle } from "@/components/markdown/markdown-hybrid-editor";
import { MarkdownHybridEditor } from "@/components/markdown/markdown-hybrid-editor";
import { api } from "@/lib/api";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { unwrapEden } from "@/lib/errors/api";
import { toSafeId } from "@/lib/safe-id";
import { useSettingsMutation } from "@/routes/_protected.settings/-hooks/use-settings-mutation";

const billingDraftKeys = {
  all: () => ["billing-draft-configuration"] as const,
};
type BillingConfigurationUpdate = NonNullable<
  Parameters<(typeof api)["organization-settings"]["billing-drafts"]["post"]>[0]
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
      unwrapEden(
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
      unwrapEden(
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
      return unwrapEden(
        await filesRoute({ resourceId: editingId }).get({ fetch: { signal } }),
      );
    },
  });
  const mutation = useSettingsMutation({
    mutationFn: async (body: BillingConfigurationUpdate) =>
      unwrapEden(
        await api["organization-settings"]["billing-drafts"].post(body),
      ),
    invalidate: billingDraftKeys.all(),
    errorToast: { title: t("errors.actionFailed") },
  });
  const save = useSettingsMutation({
    mutationFn: async ({ file, source }: KnowledgeSave) =>
      unwrapEden(
        await api
          .skills({ skillId: file.skillId })
          .resources.patch({ path: file.path, content: source }),
      ),
    invalidate: billingDraftKeys.all(),
    errorToast: { title: t("errors.actionFailed") },
    onSuccess: () => setEditing(null),
    onError: () => setEditorRevision((revision) => revision + 1),
  });
  if (config.isError) {
    return (
      <Frame>
        <FramePanel>
          <p role="alert">{t("errors.actionFailed")}</p>
        </FramePanel>
      </Frame>
    );
  }
  if (!config.data) {
    return (
      <Frame>
        <FramePanel>
          <p className="text-muted-foreground text-sm">{t("common.loading")}</p>
        </FramePanel>
      </Frame>
    );
  }
  const attachedIds = config.data.files
    .filter((file) => file.clientId === (client?.id ?? null))
    .map((file) => file.fileId);

  const nextCursor = files.data?.nextCursor;
  return (
    <Frame>
      <FramePanel>
        <div className="flex flex-col gap-4">
          <h2 className="text-sm font-medium">
            {t("settings.organization.billingDrafts.title")}
          </h2>
          <p className="text-muted-foreground text-xs">
            {t("settings.organization.billingDrafts.description")}
          </p>
          {(files.isError || editor.isError) && (
            <p role="alert">{t("errors.actionFailed")}</p>
          )}
          <Field className="flex-row items-center gap-2">
            <Checkbox
              checked={config.data.mode === "enabled"}
              disabled={
                mutation.isPending ||
                (config.data.mode === "disabled" &&
                  !config.data.files.some((file) => file.clientId === null))
              }
              onCheckedChange={(enabled) =>
                mutation.mutate({ mode: enabled ? "enabled" : "disabled" })
              }
            />
            <FieldLabel>
              {t("settings.organization.billingDrafts.title")}
            </FieldLabel>
          </Field>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => setClient(null)}>
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
              <Checkbox
                checked={config.data.timeBillingFormat === "ledes"}
                onCheckedChange={(enabled) =>
                  mutation.mutate({
                    clientId: client.id,
                    timeBillingFormat: enabled ? "ledes" : "categories",
                  })
                }
                disabled={mutation.isPending}
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
          {files.isPending && (
            <p className="text-muted-foreground text-sm">
              {t("common.loading")}
            </p>
          )}
          <List>
            {files.data?.items.map((file) => (
              <ListItem key={file.id}>
                <Checkbox
                  aria-label={file.path}
                  checked={attachedIds.includes(file.id)}
                  disabled={mutation.isPending}
                  onCheckedChange={(attach) => {
                    let resourceIds = attachedIds.filter(
                      (id) => id !== file.id,
                    );
                    if (attach) {
                      resourceIds = client
                        ? [...attachedIds, file.id]
                        : [file.id];
                    }
                    mutation.mutate({
                      ...(client ? { clientId: client.id } : {}),
                      resourceIds,
                    });
                  }}
                />
                <ListItemContent>
                  <ListItemTitle>{file.path}</ListItemTitle>
                  <p className="text-muted-foreground text-xs">
                    {file.skillName}
                  </p>
                </ListItemContent>
                <Button
                  variant="ghost"
                  disabled={save.isPending}
                  onClick={() => {
                    setEditing(file);
                    setContent(undefined);
                  }}
                >
                  {t("common.edit")}
                </Button>
              </ListItem>
            ))}
          </List>
          {nextCursor && (
            <Button variant="outline" onClick={() => setCursor(nextCursor)}>
              {t("common.next")}
            </Button>
          )}
          {editing && editor.data && (
            <>
              <MarkdownHybridEditor
                ref={editorHandle}
                key={`${editing.id}:${editorRevision}`}
                markdown={content ?? editor.data.content}
                onMarkdownChange={setContent}
                imagePolicy="data-only"
              />
              <Button
                disabled={save.isPending}
                onClick={() => {
                  if (!editorHandle.current) {
                    panic("Knowledge editor save requires a mounted editor");
                  }
                  const source = editorHandle.current.captureForSave();
                  setContent(source);
                  save.mutate({ file: editing, source });
                }}
              >
                {t("common.save")}
              </Button>
            </>
          )}
        </div>
      </FramePanel>
    </Frame>
  );
};
