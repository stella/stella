import { useState } from "react";

import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Result } from "better-result";
import {
  CheckIcon,
  FileTextIcon,
  ListChecksIcon,
  PlusIcon,
  XIcon,
} from "lucide-react";
import { useFormatter, useTranslations } from "use-intl";
import * as v from "valibot";

import type { LegalListSourceLocator } from "@stll/api/types";
import { Button } from "@stll/ui/components/button";
import { Input } from "@stll/ui/components/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/components/select";
import { Skeleton } from "@stll/ui/components/skeleton";
import { stellaToast } from "@stll/ui/components/toast";
import { cn } from "@stll/ui/lib/utils";

import { api } from "@/lib/api";
import { ensureRouteQueryData } from "@/lib/react-query";
import { toSafeId } from "@/lib/safe-id";
import { FieldValue } from "@/routes/_protected.workspaces/$workspaceId/-components/field-value";
import { useInspectorStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";
import {
  ITEM_TYPE_TRANSLATION_KEYS,
  LIST_ITEM_TYPES,
  isListItemType,
} from "@/routes/_protected.workspaces/$workspaceId/-components/tasks/task-detail-constants";
import type { ListItemType } from "@/routes/_protected.workspaces/$workspaceId/-components/tasks/task-detail-constants";
import { entitiesKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";
import {
  legalListActivityOptions,
  legalListItemsOptions,
  legalListCandidatesOptions,
  legalListGenerationsOptions,
  legalListKeys,
  legalListOptions,
  legalListSourcesOptions,
  legalListsOptions,
} from "@/routes/_protected.workspaces/$workspaceId/-queries/legal-lists";
import { propertiesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/properties";

const searchSchema = v.object({
  list: v.optional(v.string()),
});

const NO_SECTION_VALUE = "__none";
const NO_COLUMN_VALUE = "__none";

export const Route = createFileRoute(
  "/_protected/workspaces/$workspaceId/lists",
)({
  validateSearch: searchSchema,
  loader: async ({ context, params }) => {
    await ensureRouteQueryData(
      context.queryClient,
      legalListsOptions(params.workspaceId),
    );
  },
  component: LegalListsPage,
});

function LegalListsPage() {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const navigate = Route.useNavigate();
  const workspaceId = Route.useParams({
    select: (params) => params.workspaceId,
  });
  const requestedListId = Route.useSearch({ select: (search) => search.list });
  const { data } = useSuspenseQuery(legalListsOptions(workspaceId));
  const selectedListId = requestedListId ?? data.items.at(0)?.id ?? "";
  const [newListName, setNewListName] = useState("");
  const [creatingList, setCreatingList] = useState(false);

  const createList = async () => {
    const name = newListName.trim();
    if (name.length === 0) {
      return;
    }
    setCreatingList(true);
    const result = await Result.tryPromise(async () => {
      const response = await api
        .lists({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .put({ name });
      if (response.error || !response.data) {
        throw response.error;
      }
      return response.data;
    });
    setCreatingList(false);
    if (result.isErr()) {
      stellaToast.add({ title: t("errors.actionFailed"), type: "error" });
      return;
    }
    setNewListName("");
    await queryClient.invalidateQueries({
      queryKey: legalListKeys.all(workspaceId),
    });
    await navigate({
      search: { list: result.value.id },
      replace: true,
    });
  };

  return (
    <main className="bg-muted/30 flex h-full min-h-0">
      <aside className="bg-background flex w-64 shrink-0 flex-col border-e">
        <header className="flex items-center gap-2 border-b px-4 py-3">
          <ListChecksIcon className="size-4" />
          <h1 className="text-sm font-semibold">{t("editor.listsGroup")}</h1>
        </header>
        <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-2">
          {data.items.map((list) => (
            <Button
              className={cn("h-auto justify-start px-3 py-2", {
                "bg-muted": list.id === selectedListId,
              })}
              key={list.id}
              onClick={() => navigate({ search: { list: list.id } })}
              variant="ghost"
            >
              <span className="truncate">{list.name}</span>
            </Button>
          ))}
        </div>
        <form
          className="flex gap-2 border-t p-2"
          onSubmit={(event) => {
            event.preventDefault();
            void createList();
          }}
        >
          <Input
            aria-label={t("common.name")}
            maxLength={256}
            onChange={(event) => setNewListName(event.target.value)}
            placeholder={t("common.name")}
            value={newListName}
          />
          <Button
            aria-label={t("common.add")}
            disabled={creatingList || newListName.trim().length === 0}
            size="icon"
            type="submit"
          >
            <PlusIcon />
          </Button>
        </form>
      </aside>

      <section className="bg-background min-w-0 flex-1 overflow-hidden">
        {selectedListId ? (
          <LegalListDetail listId={selectedListId} workspaceId={workspaceId} />
        ) : (
          <div className="text-muted-foreground grid h-full place-items-center text-sm">
            {t("common.empty")}
          </div>
        )}
      </section>
    </main>
  );
}

type LegalListDetailProps = {
  workspaceId: string;
  listId: string;
};

const LegalListDetail = ({ workspaceId, listId }: LegalListDetailProps) => {
  const t = useTranslations();
  const formatter = useFormatter();
  const queryClient = useQueryClient();
  const navigate = Route.useNavigate();
  const list = useQuery(legalListOptions(workspaceId, listId));
  const items = useInfiniteQuery(legalListItemsOptions(workspaceId, listId));
  const properties = useQuery(propertiesOptions(workspaceId));
  const generations = useQuery(
    legalListGenerationsOptions(workspaceId, listId),
  );
  const reviewRun = generations.data?.items.find(
    (run) => run.status === "review" || run.status === "running",
  );
  const candidates = useQuery(
    legalListCandidatesOptions(workspaceId, listId, reviewRun?.id ?? ""),
  );
  const [name, setName] = useState("");
  const [itemType, setItemType] = useState<ListItemType>("task");
  const [sectionName, setSectionName] = useState("");
  const [selectedSectionId, setSelectedSectionId] = useState(NO_SECTION_VALUE);
  const [sourceItemId, setSourceItemId] = useState("");
  const [selectedPropertyId, setSelectedPropertyId] = useState(NO_COLUMN_VALUE);
  const [creating, setCreating] = useState(false);

  const createItem = async () => {
    const itemName = name.trim();
    if (itemName.length === 0) {
      return;
    }
    setCreating(true);
    const result = await Result.tryPromise(async () => {
      const response = await api
        .tasks({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .put({
          queryKey: entitiesKeys.all(workspaceId),
          name: itemName,
          listId: toSafeId<"legalList">(listId),
          listItemType: itemType,
          ...(selectedSectionId !== NO_SECTION_VALUE && {
            listSectionId: toSafeId<"legalListSection">(selectedSectionId),
          }),
        });
      if (response.error) {
        throw response.error;
      }
    });
    setCreating(false);
    if (result.isErr()) {
      stellaToast.add({ title: t("errors.actionFailed"), type: "error" });
      return;
    }
    setName("");
    await queryClient.invalidateQueries({
      queryKey: legalListKeys.items(workspaceId, listId),
    });
  };

  const verifyItem = async (itemEntityId: string) => {
    const response = await api
      .lists({ workspaceId: toSafeId<"workspace">(workspaceId) })
      ["item-reviews"].post({
        listId: toSafeId<"legalList">(listId),
        itemEntityId: toSafeId<"entity">(itemEntityId),
        decision: "verified",
      });
    if (response.error) {
      stellaToast.add({ title: t("errors.actionFailed"), type: "error" });
      return;
    }
    await queryClient.invalidateQueries({
      queryKey: legalListKeys.items(workspaceId, listId),
    });
  };

  const createSection = async () => {
    const nextSectionName = sectionName.trim();
    if (nextSectionName.length === 0) {
      return;
    }
    const response = await api
      .lists({ workspaceId: toSafeId<"workspace">(workspaceId) })
      .sections.post({
        listId: toSafeId<"legalList">(listId),
        name: nextSectionName,
      });
    if (response.error) {
      stellaToast.add({ title: t("errors.actionFailed"), type: "error" });
      return;
    }
    setSectionName("");
    await queryClient.invalidateQueries({
      queryKey: legalListKeys.detail(workspaceId, listId),
    });
  };

  const addColumn = async () => {
    if (selectedPropertyId === NO_COLUMN_VALUE) {
      return;
    }
    const response = await api
      .lists({ workspaceId: toSafeId<"workspace">(workspaceId) })
      .columns.post({
        listId: toSafeId<"legalList">(listId),
        propertyId: toSafeId<"property">(selectedPropertyId),
      });
    if (response.error) {
      stellaToast.add({ title: t("errors.actionFailed"), type: "error" });
      return;
    }
    setSelectedPropertyId(NO_COLUMN_VALUE);
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: legalListKeys.detail(workspaceId, listId),
      }),
      queryClient.invalidateQueries({
        queryKey: legalListKeys.items(workspaceId, listId),
      }),
    ]);
  };

  const decideCandidate = async (
    candidateId: string,
    decision: "accept" | "reject",
  ) => {
    if (!reviewRun) {
      return;
    }
    const endpoint = api.lists({
      workspaceId: toSafeId<"workspace">(workspaceId),
    })["generation-candidates"];
    const input = {
      listId: toSafeId<"legalList">(listId),
      runId: toSafeId<"legalListGenerationRun">(reviewRun.id),
      candidateId: toSafeId<"legalListGenerationCandidate">(candidateId),
    };
    const response =
      decision === "accept"
        ? await endpoint.accept.post(input)
        : await endpoint.reject.post(input);
    if (response.error) {
      stellaToast.add({ title: t("errors.actionFailed"), type: "error" });
      return;
    }
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: legalListKeys.items(workspaceId, listId),
      }),
      queryClient.invalidateQueries({
        queryKey: legalListKeys.generations(workspaceId, listId),
      }),
    ]);
  };

  if (list.isPending || items.isPending) {
    return <ListSkeleton />;
  }
  if (!list.data || !items.data) {
    return null;
  }
  const listItems = items.data.pages.flatMap((page) => page.items);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-start justify-between gap-4 border-b px-6 py-4">
        <div className="min-w-0">
          <h2 className="truncate text-lg font-semibold">{list.data.name}</h2>
          {list.data.description && (
            <p className="text-muted-foreground mt-1 text-sm">
              {list.data.description}
            </p>
          )}
        </div>
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void createSection();
          }}
        >
          <Input
            aria-label={t("common.category")}
            className="w-44"
            maxLength={256}
            onChange={(event) => setSectionName(event.target.value)}
            placeholder={t("common.category")}
            value={sectionName}
          />
          <Button
            disabled={sectionName.trim().length === 0}
            size="sm"
            type="submit"
            variant="outline"
          >
            <PlusIcon />
            {t("common.add")}
          </Button>
          {properties.data && (
            <>
              <Select
                onValueChange={(value) =>
                  setSelectedPropertyId(value ?? NO_COLUMN_VALUE)
                }
                value={selectedPropertyId}
              >
                <SelectTrigger className="w-44">
                  <SelectValue>
                    {(value) =>
                      properties.data.find((property) => property.id === value)
                        ?.name ?? t("common.add")
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value={NO_COLUMN_VALUE}>
                    {t("common.empty")}
                  </SelectItem>
                  {properties.data
                    .filter(
                      (property) =>
                        !list.data?.columns.some(
                          (column) => column.propertyId === property.id,
                        ),
                    )
                    .map((property) => (
                      <SelectItem key={property.id} value={property.id}>
                        {property.name}
                      </SelectItem>
                    ))}
                </SelectPopup>
              </Select>
              <Button
                disabled={selectedPropertyId === NO_COLUMN_VALUE}
                onClick={() => void addColumn()}
                size="sm"
                type="button"
                variant="outline"
              >
                <PlusIcon />
                {t("common.add")}
              </Button>
            </>
          )}
          <span className="text-muted-foreground rounded-md border px-2 py-1 text-xs">
            {formatter.number(list.data.itemCount)}
          </span>
        </form>
      </header>
      <form
        className="flex gap-2 border-b px-6 py-3"
        onSubmit={(event) => {
          event.preventDefault();
          void createItem();
        }}
      >
        <Input
          aria-label={t("templates.addItem")}
          maxLength={255}
          onChange={(event) => setName(event.target.value)}
          placeholder={t("templates.addItem")}
          value={name}
        />
        <Select
          onValueChange={(value) => {
            if (isListItemType(value)) {
              setItemType(value);
            }
          }}
          value={itemType}
        >
          <SelectTrigger className="w-40">
            <SelectValue>
              {(value) =>
                value ? t(ITEM_TYPE_TRANSLATION_KEYS[value]) : t("common.kind")
              }
            </SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {LIST_ITEM_TYPES.map((type) => (
              <SelectItem key={type} value={type}>
                {t(ITEM_TYPE_TRANSLATION_KEYS[type])}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        {list.data.sections.length > 0 && (
          <Select
            onValueChange={(value) =>
              setSelectedSectionId(value ?? NO_SECTION_VALUE)
            }
            value={selectedSectionId}
          >
            <SelectTrigger className="w-48">
              <SelectValue>
                {(value) =>
                  list.data.sections.find((section) => section.id === value)
                    ?.name ?? t("common.category")
                }
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value={NO_SECTION_VALUE}>
                {t("common.empty")}
              </SelectItem>
              {list.data.sections.map((section) => (
                <SelectItem key={section.id} value={section.id}>
                  {section.name}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        )}
        <Button disabled={creating || name.trim().length === 0} type="submit">
          <PlusIcon />
          {t("common.add")}
        </Button>
      </form>
      {candidates.data &&
        candidates.data.items.some(
          (candidate) =>
            candidate.status === "pending" || candidate.status === "accepting",
        ) && (
          <section className="bg-muted/30 border-b px-6 py-3">
            <p className="text-muted-foreground mb-2 text-xs font-medium">
              {reviewRun?.instruction}
            </p>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {candidates.data.items
                .filter(
                  (candidate) =>
                    candidate.status === "pending" ||
                    candidate.status === "accepting",
                )
                .map((candidate) => (
                  <article
                    className="bg-background w-80 shrink-0 rounded-lg border p-3"
                    key={candidate.id}
                  >
                    <h3 className="truncate text-sm font-medium">
                      {candidate.name}
                    </h3>
                    {candidate.description && (
                      <p className="text-muted-foreground mt-1 line-clamp-2 text-xs">
                        {candidate.description}
                      </p>
                    )}
                    <div className="mt-3 flex justify-end gap-1">
                      <Button
                        disabled={candidate.status === "accepting"}
                        onClick={() =>
                          void decideCandidate(candidate.id, "reject")
                        }
                        size="sm"
                        variant="ghost"
                      >
                        {t("common.decline")}
                      </Button>
                      <Button
                        onClick={() =>
                          void decideCandidate(candidate.id, "accept")
                        }
                        size="sm"
                      >
                        {t("common.accept")}
                      </Button>
                    </div>
                  </article>
                ))}
            </div>
          </section>
        )}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-sm">
          <thead className="bg-muted/80 sticky top-0 z-10 text-start backdrop-blur">
            <tr className="border-b">
              <th className="px-4 py-2 text-start font-medium">
                {t("common.name")}
              </th>
              <th className="px-4 py-2 text-start font-medium">
                {t("common.description")}
              </th>
              <th className="px-4 py-2 text-start font-medium">
                {t("common.category")}
              </th>
              <th className="px-4 py-2 text-start font-medium">
                {t("tasks.status")}
              </th>
              <th className="px-4 py-2 text-start font-medium">
                {t("tasks.priority")}
              </th>
              <th className="px-4 py-2 text-start font-medium">
                {t("tasks.dueDate")}
              </th>
              {list.data.columns.map((column) => (
                <th
                  className="px-4 py-2 text-start font-medium"
                  key={column.id}
                >
                  {column.name}
                </th>
              ))}
              <th className="px-4 py-2 text-end font-medium">
                {t("common.actions")}
              </th>
            </tr>
          </thead>
          <tbody>
            {listItems.map((item) => (
              <tr className="border-b last:border-0" key={item.id}>
                <td className="max-w-80 px-4 py-3 font-medium">
                  <div className="flex items-center gap-2">
                    {isListItemType(item.itemType) && (
                      <span className="text-muted-foreground rounded-md border px-1.5 py-0.5 text-xs font-normal">
                        {t(ITEM_TYPE_TRANSLATION_KEYS[item.itemType])}
                      </span>
                    )}
                    <Button
                      className="h-auto min-w-0 justify-start p-0 font-medium"
                      onClick={() =>
                        useInspectorStore.getState().openTask({
                          taskId: item.id,
                          workspaceId,
                          isNew: false,
                        })
                      }
                      variant="link"
                    >
                      <span className="truncate">{item.name}</span>
                    </Button>
                  </div>
                </td>
                <td className="text-muted-foreground max-w-96 truncate px-4 py-3">
                  {item.description ?? ""}
                </td>
                <td className="text-muted-foreground px-4 py-3">
                  {list.data.sections.find(
                    (section) => section.id === item.sectionId,
                  )?.name ?? ""}
                </td>
                <td className="px-4 py-3">{item.status}</td>
                <td className="px-4 py-3">{item.priority}</td>
                <td className="px-4 py-3">{item.dueDate ?? ""}</td>
                {list.data.columns.map((column) => {
                  const property = properties.data?.find(
                    (candidate) => candidate.id === column.propertyId,
                  );
                  const field = item.customFields.find(
                    (candidate) => candidate.propertyId === column.propertyId,
                  );
                  return (
                    <td className="px-4 py-3" key={column.id}>
                      {property && (
                        <FieldValue
                          content={field?.content}
                          property={property}
                          variant="table"
                        />
                      )}
                    </td>
                  );
                })}
                <td className="px-4 py-2 text-end">
                  <Button
                    aria-label={t("common.document")}
                    onClick={() =>
                      setSourceItemId((current) =>
                        current === item.id ? "" : item.id,
                      )
                    }
                    size="icon-sm"
                    variant="ghost"
                  >
                    <FileTextIcon />
                  </Button>
                  <Button
                    aria-label={t("common.accept")}
                    disabled={item.reviewStatus === "verified"}
                    onClick={() => void verifyItem(item.id)}
                    size="icon-sm"
                    variant="ghost"
                  >
                    <CheckIcon />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {listItems.length === 0 && (
          <div className="text-muted-foreground grid h-48 place-items-center text-sm">
            {t("common.empty")}
          </div>
        )}
        {items.hasNextPage && (
          <div className="flex justify-center p-4">
            <Button
              disabled={items.isFetchingNextPage}
              onClick={() => void items.fetchNextPage()}
              variant="outline"
            >
              {t("common.loadMore")}
            </Button>
          </div>
        )}
      </div>
      {sourceItemId && (
        <ItemSourcesPanel
          itemEntityId={sourceItemId}
          listId={listId}
          onClose={() => setSourceItemId("")}
          onOpenDocument={(entityId, pdfPage) =>
            navigate({
              to: "/workspaces/$workspaceId/entities/$entityId",
              params: { workspaceId, entityId },
              search: { pdfPage },
            })
          }
          workspaceId={workspaceId}
        />
      )}
    </div>
  );
};

type ItemSourcesPanelProps = {
  workspaceId: string;
  listId: string;
  itemEntityId: string;
  onClose: () => void;
  onOpenDocument: (entityId: string, pdfPage?: number) => void;
};

const ItemSourcesPanel = ({
  workspaceId,
  listId,
  itemEntityId,
  onClose,
  onOpenDocument,
}: ItemSourcesPanelProps) => {
  const t = useTranslations();
  const formatter = useFormatter();
  const queryClient = useQueryClient();
  const { data, isPending } = useQuery(
    legalListSourcesOptions(workspaceId, listId, itemEntityId),
  );
  const activity = useQuery(
    legalListActivityOptions(workspaceId, listId, itemEntityId),
  );

  const verifySource = async (sourceId: string) => {
    const response = await api
      .lists({ workspaceId: toSafeId<"workspace">(workspaceId) })
      ["item-sources"].patch({
        id: toSafeId<"legalListItemSource">(sourceId),
        listId: toSafeId<"legalList">(listId),
        itemEntityId: toSafeId<"entity">(itemEntityId),
        status: "verified",
      });
    if (response.error) {
      stellaToast.add({ title: t("errors.actionFailed"), type: "error" });
      return;
    }
    await queryClient.invalidateQueries({
      queryKey: legalListKeys.sources(workspaceId, listId, itemEntityId),
    });
  };

  return (
    <aside className="bg-background max-h-72 shrink-0 overflow-y-auto border-t p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-medium">{t("common.document")}</h3>
        <Button
          aria-label={t("common.close")}
          onClick={onClose}
          size="icon-sm"
          variant="ghost"
        >
          <XIcon />
        </Button>
      </div>
      {isPending ? (
        <Skeleton className="h-16 w-full" />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          <div className="grid content-start gap-2">
            {data?.items.map((source) => (
              <article className="rounded-lg border p-3" key={source.id}>
                <div className="flex items-center justify-between gap-2">
                  <Button
                    className="h-auto min-w-0 justify-start p-0"
                    onClick={() =>
                      onOpenDocument(
                        source.sourceEntityId,
                        source.locator.type === "pdf-page"
                          ? source.locator.pageNumber
                          : undefined,
                      )
                    }
                    variant="link"
                  >
                    <span className="truncate">
                      <SourceLocatorLabel locator={source.locator} />
                    </span>
                  </Button>
                  <Button
                    aria-label={t("common.accept")}
                    disabled={source.verificationStatus === "verified"}
                    onClick={() => void verifySource(source.id)}
                    size="icon-sm"
                    variant="ghost"
                  >
                    <CheckIcon />
                  </Button>
                </div>
                {source.quote && (
                  <blockquote className="text-muted-foreground mt-2 line-clamp-3 text-xs">
                    {source.quote}
                  </blockquote>
                )}
              </article>
            ))}
            {data?.items.length === 0 && (
              <p className="text-muted-foreground text-sm">
                {t("common.empty")}
              </p>
            )}
          </div>
          <section>
            <h4 className="mb-2 text-sm font-medium">{t("common.history")}</h4>
            <ol className="grid gap-2">
              {activity.data?.items.map((event) => (
                <li className="rounded-lg border p-3 text-xs" key={event.id}>
                  <p>{getActivityLabel(event.operation, t)}</p>
                  <p className="text-muted-foreground mt-1">
                    {event.userId} · {formatter.dateTime(event.createdAt)}
                  </p>
                </li>
              ))}
              {activity.data?.items.length === 0 && (
                <li className="text-muted-foreground text-sm">
                  {t("common.empty")}
                </li>
              )}
            </ol>
          </section>
        </div>
      )}
    </aside>
  );
};

const getActivityLabel = (
  operation: string | null,
  t: ReturnType<typeof useTranslations>,
) => {
  if (operation === "source_added") {
    return t("common.document");
  }
  if (
    operation === "source_verified" ||
    operation === "review_recorded" ||
    operation === "generation_candidate_accepted"
  ) {
    return t("common.accept");
  }
  return t("common.history");
};

const SourceLocatorLabel = ({
  locator,
}: {
  locator: LegalListSourceLocator;
}) => {
  const t = useTranslations();
  if (locator.type === "pdf-page") {
    return `${t("common.document")} · ${locator.pageNumber}`;
  }
  if (locator.type === "docx-block") {
    return locator.blockId;
  }
  return t("common.document");
};

const ListSkeleton = () => (
  <div className="space-y-3 p-6">
    <Skeleton className="h-7 w-64" />
    <Skeleton className="h-10 w-full" />
    <Skeleton className="h-64 w-full" />
  </div>
);
