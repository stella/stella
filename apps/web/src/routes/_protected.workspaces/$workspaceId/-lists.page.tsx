import { useState } from "react";

import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import type { InferDataFromTag } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { AUDIT_CHANGES_STATUS } from "@stll/api-contract/audit-log";
import { DEFAULT_VARCHAR_MAX_LENGTH } from "@stll/api-contract/limits";
import { Button } from "@stll/ui/button";
import { Form } from "@stll/ui/form";
import { CheckIcon, FileTextIcon, PlusIcon, XIcon } from "@stll/ui/icons";
import { Input } from "@stll/ui/input";
import { ScrollArea } from "@stll/ui/scroll-area";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";
import { Skeleton } from "@stll/ui/skeleton";
import { TableCell } from "@stll/ui/table";
import { TruncatedText } from "@stll/ui/truncated-text";

import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import { QueryViewFeedback } from "@/components/query-view-feedback";
import { FieldValue } from "@/components/workspaces/field-value";
import { GenerationCandidatesReview } from "@/components/workspaces/generation-candidates-review";
import { ListItemSources } from "@/components/workspaces/list-item-sources";
import {
  isListItemType,
  isTaskPriority,
  isTaskStatus,
  ITEM_TYPE_TRANSLATION_KEYS,
  LIST_ITEM_TYPES,
} from "@/components/workspaces/tasks/task-detail-constants";
import type { ListItemType } from "@/components/workspaces/tasks/task-detail-constants";
import { useFormatter } from "@/i18n/formatting-context";
import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { invokeCapability } from "@/lib/capabilities/capability-request";
import { detached } from "@/lib/detached";
import { toAPIError, unwrapApiResponse } from "@/lib/errors/api";
import { notifyUserError } from "@/lib/errors/user-toast";
import { useIdempotentSubmit } from "@/lib/idempotency/use-idempotent-submit";
import { useCallerFeatureEnabled } from "@/lib/organization/feature-access/access";
import { CALLER_FEATURE } from "@/lib/organization/feature-access/surfaces";
import { queryView, queryViewError } from "@/lib/query-view.logic";
import type { QueryView } from "@/lib/query-view.logic";
import { toSafeId } from "@/lib/safe-id";
import { usePropertyDisplayName } from "@/lib/workspaces/property-display-name";
import {
  legalListActivityOptions,
  legalListCandidatesOptions,
  legalListGenerationsOptions,
  legalListItemsOptions,
  legalListKeys,
  legalListOptions,
  legalListsOptions,
  legalListSourcesOptions,
} from "@/lib/workspaces/queries/legal-lists";
import { propertiesOptions } from "@/lib/workspaces/queries/properties";
import { ListSourceAction } from "@/routes/_protected.workspaces/$workspaceId/-components/list-source-action";
import { useDefaultWorkspaceViewRedirect } from "@/routes/_protected.workspaces/$workspaceId/-default-view-redirect";

import {
  ListDetailPending,
  ListDetailShell,
  ListPropertyControlsPending,
  ListsPending,
  ListsShell,
  ListTable,
  ListTableRow,
  ListTableRowsPending,
  ListTableScroll,
} from "./-lists.pending";

const routeApi = getRouteApi("/_protected/workspaces/$workspaceId/lists");

const NO_SECTION_VALUE = "__none";
const NO_COLUMN_VALUE = "__none";

export function ListsRoutePage() {
  const enabled = useCallerFeatureEnabled(CALLER_FEATURE.legalLists);
  return enabled ? <LegalListsPage /> : <DisabledListsRedirect />;
}

function DisabledListsRedirect() {
  const queryClient = routeApi.useRouteContext({
    select: (context) => context.queryClient,
  });
  const workspaceId = routeApi.useParams({
    select: (params) => params.workspaceId,
  });
  useDefaultWorkspaceViewRedirect({ queryClient, workspaceId });

  return <ListsPending />;
}

function LegalListsPage() {
  const submit = useIdempotentSubmit();
  const t = useTranslations();
  const queryClient = useQueryClient();
  const navigate = routeApi.useNavigate();
  const workspaceId = routeApi.useParams({
    select: (params) => params.workspaceId,
  });
  const requestedListId = routeApi.useSearch({
    select: (search) => search.list,
  });
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
      const response = await submit.run({
        operation: `lists.create:${workspaceId}`,
        body: { name },
        send: api.lists({ workspaceId: toSafeId<"workspace">(workspaceId) })
          .put,
      });
      return unwrapApiResponse(response);
    });
    setCreatingList(false);
    if (result.isErr()) {
      getAnalytics().captureError(result.error, {
        fingerprintKey: "LegalListsPage.createList:failure",
        scope: {
          type: "handler",
          handlerId: "LegalListsPage.createList:failure",
        },
      });
      notifyUserError(result.error, t("errors.actionFailed"));
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
    <ListsShell
      lists={data.items.map((list) => (
        <Button
          className="w-full justify-start"
          key={list.id}
          onClick={() =>
            detached(navigate({ search: { list: list.id } }), "lists.navigate")
          }
          variant={list.id === selectedListId ? "muted" : "ghost"}
        >
          <TruncatedText>{list.name}</TruncatedText>
        </Button>
      ))}
      createList={
        <Form
          density="compact"
          layout="inline"
          onSubmit={(event) => {
            event.preventDefault();
            detached(createList(), "lists.create-list");
          }}
        >
          <Input
            aria-label={t("common.name")}
            maxLength={DEFAULT_VARCHAR_MAX_LENGTH}
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
        </Form>
      }
    >
      {selectedListId ? (
        <LegalListDetail
          key={selectedListId}
          listId={selectedListId}
          workspaceId={workspaceId}
        />
      ) : (
        <div className="text-muted-foreground grid h-full place-items-center text-sm">
          {t("common.empty")}
        </div>
      )}
    </ListsShell>
  );
}

const listQueryFailure = <TData, TError>(view: QueryView<TData, TError>) =>
  queryViewError(view) === undefined ? null : <QueryViewFeedback view={view} />;

type LegalListDetailProps = {
  workspaceId: string;
  listId: string;
};

const LegalListDetail = ({ workspaceId, listId }: LegalListDetailProps) => {
  const user = useAuthenticatedUser();
  const t = useTranslations();
  const formatter = useFormatter();
  const queryClient = useQueryClient();
  const list = useQuery(legalListOptions(workspaceId, listId));
  const listView = queryView(list);
  const listData = listView.type === "items" ? listView.items : undefined;
  const items = useInfiniteQuery(
    legalListItemsOptions({
      workspaceId,
      listId,
      viewer: { userId: user.id, organizationId: user.activeOrganizationId },
    }),
  );
  const itemsView = queryView(items);
  const itemsData = itemsView.type === "items" ? itemsView.items : undefined;
  const properties = useQuery(propertiesOptions(workspaceId));
  const propertyName = usePropertyDisplayName();
  const propertiesView = queryView(properties, { isEmpty: () => false });
  const propertiesData =
    propertiesView.type === "items" ? propertiesView.items : undefined;
  const generations = useQuery(
    legalListGenerationsOptions(workspaceId, listId),
  );
  const generationsView = queryView(generations);
  const generationsData =
    generationsView.type === "items" ? generationsView.items : undefined;
  const reviewRun = generationsData?.items.find(
    (run) => run.status === "review" || run.status === "running",
  );
  const candidates = useQuery(
    legalListCandidatesOptions(workspaceId, listId, reviewRun?.id ?? ""),
  );
  const candidatesView = queryView(candidates);
  const candidatesData =
    candidatesView.type === "items" ? candidatesView.items : undefined;
  const submit = useIdempotentSubmit();
  const [sectionName, setSectionName] = useState("");
  const [sourceItemId, setSourceItemId] = useState("");
  const [selectedPropertyId, setSelectedPropertyId] = useState(NO_COLUMN_VALUE);

  const verifyItem = async (itemEntityId: string) => {
    const listsApi = api.lists({
      workspaceId: toSafeId<"workspace">(workspaceId),
    });

    const response = await invokeCapability(
      "lists.items.reviews.update",
      async (request) =>
        listsApi["item-reviews"].post(
          {
            listId: toSafeId<"legalList">(listId),
            itemEntityId: toSafeId<"entity">(itemEntityId),
            decision: "verified",
          },
          request,
        ),
    );
    if (response.error) {
      notifyUserError(toAPIError(response.error), t("errors.actionFailed"));
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
    const response = await submit.run({
      operation: `lists.sections.create:${workspaceId}`,
      body: {
        listId: toSafeId<"legalList">(listId),
        name: nextSectionName,
      },
      send: api.lists({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .sections.post,
    });
    if (response.error) {
      notifyUserError(toAPIError(response.error), t("errors.actionFailed"));
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
    const response = await submit.run({
      operation: `lists.columns.create:${workspaceId}`,
      body: {
        listId: toSafeId<"legalList">(listId),
        propertyId: toSafeId<"property">(selectedPropertyId),
      },
      send: api.lists({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .columns.post,
    });
    if (response.error) {
      notifyUserError(toAPIError(response.error), t("errors.actionFailed"));
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

  if (!listData) {
    return listQueryFailure(listView) ?? <ListDetailPending />;
  }
  const listItems = itemsData?.pages.flatMap((page) => page.items);
  const feedback =
    listQueryFailure(itemsView) ??
    listQueryFailure(listView) ??
    listQueryFailure(propertiesView) ??
    listQueryFailure(generationsView) ??
    (reviewRun && listQueryFailure(candidatesView));

  return (
    <ListDetailShell
      heading={
        <>
          <h2 className="min-w-0 text-lg font-semibold">
            <TruncatedText>{listData.name}</TruncatedText>
          </h2>
          {listData.description && (
            <p className="text-muted-foreground mt-1 text-sm">
              {listData.description}
            </p>
          )}
        </>
      }
      tools={
        <Form
          className="w-auto"
          density="compact"
          layout="inline"
          onSubmit={(event) => {
            event.preventDefault();
            detached(createSection(), "lists.create-section");
          }}
        >
          <Input
            aria-label={t("common.category")}
            className="w-44"
            maxLength={DEFAULT_VARCHAR_MAX_LENGTH}
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
          {propertiesView.type === "pending" && <ListPropertyControlsPending />}
          {propertiesData && (
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
                      propertiesData.find((property) => property.id === value)
                        ?.name ?? t("common.add")
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value={NO_COLUMN_VALUE}>
                    {t("common.empty")}
                  </SelectItem>
                  {propertiesData
                    .filter(
                      (property) =>
                        !listData.columns.some(
                          (column) => column.propertyId === property.id,
                        ),
                    )
                    .map((property) => (
                      <SelectItem key={property.id} value={property.id}>
                        {propertyName(property)}
                      </SelectItem>
                    ))}
                </SelectPopup>
              </Select>
              <Button
                disabled={selectedPropertyId === NO_COLUMN_VALUE}
                onClick={() => detached(addColumn(), "lists.add-column")}
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
            {formatter.number(listData.itemCount)}
          </span>
        </Form>
      }
      createItem={
        <ListCreateItemForm
          listId={listId}
          sections={listData.sections}
          workspaceId={workspaceId}
        />
      }
    >
      {feedback && <div className="px-6 py-2">{feedback}</div>}
      {reviewRun && candidatesData && (
        <div className="bg-muted/30 border-b px-6 py-3 empty:hidden">
          <GenerationCandidatesReview
            canDecide
            candidates={candidatesData.items}
            layout="strip"
            listId={listId}
            runId={reviewRun.id}
            title={reviewRun.instruction}
            workspaceId={workspaceId}
          />
        </div>
      )}
      <ListTableScroll>
        <ListItemsTable
          busy={itemsView.type === "pending"}
          listData={listData}
          listItems={listItems}
          openSources={(itemId) =>
            setSourceItemId((current) => (current === itemId ? "" : itemId))
          }
          propertiesData={propertiesData}
          verifyItem={verifyItem}
          workspaceId={workspaceId}
        />
        {listItems?.length === 0 && (
          <div className="text-muted-foreground grid h-48 place-items-center text-sm">
            {t("common.empty")}
          </div>
        )}
        {items.hasNextPage && (
          <div className="flex justify-center p-4">
            <Button
              disabled={items.isFetchingNextPage}
              onClick={() =>
                detached(items.fetchNextPage(), "lists.fetch-next-page")
              }
              variant="outline"
            >
              {t("common.loadMore")}
            </Button>
          </div>
        )}
      </ListTableScroll>
      {sourceItemId && (
        <ItemSourcesPanel
          itemEntityId={sourceItemId}
          listId={listId}
          onClose={() => setSourceItemId("")}
          workspaceId={workspaceId}
        />
      )}
    </ListDetailShell>
  );
};

type ListDetailData = InferDataFromTag<
  unknown,
  ReturnType<typeof legalListOptions>["queryKey"]
>;
type ListItemsData = InferDataFromTag<
  unknown,
  ReturnType<typeof legalListItemsOptions>["queryKey"]
>;
type ListPropertiesData = InferDataFromTag<
  unknown,
  ReturnType<typeof propertiesOptions>["queryKey"]
>;

type ListItemsTableProps = {
  busy: boolean;
  listData: ListDetailData;
  listItems: ListItemsData["pages"][number]["items"] | undefined;
  openSources: (itemId: string) => void;
  propertiesData: ListPropertiesData | undefined;
  verifyItem: (itemId: string) => Promise<void>;
  workspaceId: string;
};

const ListItemsTable = ({
  busy,
  listData,
  listItems,
  openSources,
  propertiesData,
  verifyItem,
  workspaceId,
}: ListItemsTableProps) => {
  const t = useTranslations();
  const formatter = useFormatter();

  return (
    <ListTable busy={busy} columns={listData.columns}>
      {busy && <ListTableRowsPending columns={listData.columns} />}
      {listItems?.map((item) => (
        <ListTableRow
          key={item.id}
          cells={{
            name: (
              <TableCell className="max-w-80">
                <div className="flex items-center gap-2 whitespace-normal">
                  {isListItemType(item.itemType) && (
                    <span className="text-muted-foreground rounded-md border px-1.5 py-0.5 text-xs font-normal">
                      <ListItemTypeLabel value={item.itemType} />
                    </span>
                  )}
                  <Button
                    className="min-w-0"
                    onClick={() =>
                      useInspectorTabsStore.getState().openTask({
                        taskId: item.id,
                        workspaceId,
                        isNew: false,
                      })
                    }
                    size="inline"
                  >
                    <TruncatedText>{item.name}</TruncatedText>
                  </Button>
                </div>
              </TableCell>
            ),
            description: (
              <TableCell className="max-w-96" tone="muted" truncate>
                {item.description ?? ""}
              </TableCell>
            ),
            section: (
              <TableCell tone="muted">
                <span className="leading-5 whitespace-normal">
                  {listData.sections.find(
                    (section) => section.id === item.sectionId,
                  )?.name ?? ""}
                </span>
              </TableCell>
            ),
            status: (
              <TableCell>
                {isTaskStatus(item.status)
                  ? t(`tasks.statusValues.${item.status}`)
                  : ""}
              </TableCell>
            ),
            priority: (
              <TableCell>
                {isTaskPriority(item.priority)
                  ? t(`tasks.priorityValues.${item.priority}`)
                  : ""}
              </TableCell>
            ),
            dueDate: (
              <TableCell>
                {item.dueDate
                  ? formatter.dateTime(new Date(`${item.dueDate}T00:00:00Z`), {
                      year: "numeric",
                      month: "short",
                      day: "numeric",
                      timeZone: "UTC",
                    })
                  : ""}
              </TableCell>
            ),
          }}
          customCells={listData.columns.map((column) => {
            const property = propertiesData?.find(
              (candidate) => candidate.id === column.propertyId,
            );
            const field = item.customFields.find(
              (candidate) => candidate.propertyId === column.propertyId,
            );
            return (
              <TableCell key={column.id}>
                {property && (
                  <div className="whitespace-normal">
                    <FieldValue
                      content={field?.content}
                      property={property}
                      variant="table"
                    />
                  </div>
                )}
              </TableCell>
            );
          })}
          actions={
            <TableCell align="end">
              <Button
                aria-label={t("common.document")}
                onClick={() => openSources(item.id)}
                size="icon-sm"
                variant="ghost"
              >
                <FileTextIcon />
              </Button>
              <Button
                aria-label={t("common.accept")}
                disabled={item.reviewStatus === "verified"}
                onClick={() =>
                  detached(verifyItem(item.id), "lists.verify-item")
                }
                size="icon-sm"
                variant="ghost"
              >
                <CheckIcon />
              </Button>
            </TableCell>
          }
        />
      ))}
    </ListTable>
  );
};

const TASK_NAME_MAX_LENGTH = 255;

type ListCreateItemFormProps = {
  listId: string;
  sections: ListDetailData["sections"];
  workspaceId: string;
};

const ListCreateItemForm = ({
  listId,
  sections,
  workspaceId,
}: ListCreateItemFormProps) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const submit = useIdempotentSubmit();
  const [name, setName] = useState("");
  const [itemType, setItemType] = useState<ListItemType>("task");
  const [selectedSectionId, setSelectedSectionId] = useState(NO_SECTION_VALUE);
  const [creating, setCreating] = useState(false);

  const createItem = async () => {
    const itemName = name.trim();
    if (itemName.length === 0) {
      return;
    }
    setCreating(true);
    const result = await Result.tryPromise(async () => {
      const response = await submit.run({
        operation: `tasks.create:${workspaceId}`,
        body: {
          name: itemName,
          listId: toSafeId<"legalList">(listId),
          listItemType: itemType,
          ...(selectedSectionId !== NO_SECTION_VALUE && {
            listSectionId: toSafeId<"legalListSection">(selectedSectionId),
          }),
        },
        send: async (body, replayRequest) =>
          invokeCapability("tasks.create", async (request) =>
            api
              .tasks({ workspaceId: toSafeId<"workspace">(workspaceId) })
              .put(body, {
                ...request,
                headers: {
                  "Idempotency-Key": replayRequest.headers["Idempotency-Key"],
                  ...request.headers,
                },
              }),
          ),
      });
      unwrapApiResponse(response);
    });
    setCreating(false);
    if (result.isErr()) {
      getAnalytics().captureError(result.error, {
        fingerprintKey: "LegalListDetail.createItem:failure",
        scope: {
          type: "handler",
          handlerId: "LegalListDetail.createItem:failure",
        },
      });
      notifyUserError(result.error, t("errors.actionFailed"));
      return;
    }
    setName("");
    await queryClient.invalidateQueries({
      queryKey: legalListKeys.items(workspaceId, listId),
    });
  };

  return (
    <Form
      density="compact"
      layout="inline"
      onSubmit={(event) => {
        event.preventDefault();
        detached(createItem(), "lists.create-item");
      }}
    >
      <Input
        aria-label={t("templates.addItem")}
        maxLength={TASK_NAME_MAX_LENGTH}
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
              typeof value === "string" && isListItemType(value) ? (
                <ListItemTypeLabel value={value} />
              ) : (
                t("common.kind")
              )
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
      {sections.length > 0 && (
        <Select
          onValueChange={(value) =>
            setSelectedSectionId(value ?? NO_SECTION_VALUE)
          }
          value={selectedSectionId}
        >
          <SelectTrigger className="w-48">
            <SelectValue>
              {(value) =>
                sections.find((section) => section.id === value)?.name ??
                t("common.category")
              }
            </SelectValue>
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value={NO_SECTION_VALUE}>
              {t("common.empty")}
            </SelectItem>
            {sections.map((section) => (
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
    </Form>
  );
};

type ItemSourcesPanelProps = {
  workspaceId: string;
  listId: string;
  itemEntityId: string;
  onClose: () => void;
};

const ItemSourcesPanel = ({
  workspaceId,
  listId,
  itemEntityId,
  onClose,
}: ItemSourcesPanelProps) => {
  const user = useAuthenticatedUser();
  const t = useTranslations();
  const formatter = useFormatter();
  const dataQuery = useQuery(
    legalListSourcesOptions({
      workspaceId,
      listId,
      itemEntityId,
      viewer: { userId: user.id, organizationId: user.activeOrganizationId },
    }),
  );
  const { isPending } = dataQuery;
  const activity = useQuery(
    legalListActivityOptions({
      workspaceId,
      listId,
      itemEntityId,
      viewer: { userId: user.id, organizationId: user.activeOrganizationId },
    }),
  );
  const activityView = queryView(activity);
  const activityData =
    activityView.type === "items" ? activityView.items : undefined;

  return (
    <aside className="bg-background flex max-h-72 min-h-0 shrink-0 flex-col border-t">
      <ScrollArea axis="vertical">
        <div className="p-4">
          <QueryViewFeedback view={activityView} />
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
          <ListSourceAction
            workspaceId={workspaceId}
            listId={listId}
            itemEntityId={itemEntityId}
          />
          {isPending ? (
            <Skeleton className="h-16 w-full" />
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              <div className="grid content-start gap-2">
                <ListItemSources
                  workspaceId={workspaceId}
                  listId={listId}
                  itemEntityId={itemEntityId}
                />
              </div>
              <section>
                <h4 className="mb-2 text-sm font-medium">
                  {t("common.history")}
                </h4>
                <ol className="grid gap-2">
                  {activityData?.items.map((event) => (
                    <li
                      className="rounded-lg border p-3 text-xs"
                      key={event.id}
                    >
                      <p>
                        <ActivityLabel
                          action={event.action}
                          operation={event.operation}
                        />
                      </p>
                      <p className="text-muted-foreground mt-1">
                        {event.actorName ??
                          t("workspaces.overview.activity.deletedUser")}
                        {" · "}
                        {formatter.dateTime(new Date(event.createdAt))}
                      </p>
                      {event.changesStatus ===
                        AUDIT_CHANGES_STATUS.featureUnavailable && (
                        <p className="text-muted-foreground mt-1">
                          {t("common.detailsUnavailable")}
                        </p>
                      )}
                    </li>
                  ))}
                  {activityData?.items.length === 0 && (
                    <li className="text-muted-foreground text-sm">
                      {t("common.empty")}
                    </li>
                  )}
                </ol>
              </section>
            </div>
          )}
        </div>
      </ScrollArea>
    </aside>
  );
};

const ActivityLabel = ({
  operation,
  action,
}: {
  operation: string | null;
  action: string;
}) => {
  const t = useTranslations();
  if (operation === "source_added") {
    return `${t("workspaces.overview.activity.actorActions.added")} · ${t("common.document")}`;
  }
  if (operation === "source_verified") {
    return `${t("workspaces.overview.activity.actorActions.reviewed")} · ${t("common.document")}`;
  }
  if (operation === "review_recorded") {
    return t("workspaces.overview.activity.actorActions.reviewed");
  }
  if (operation === "generation_candidate_accepted") {
    return t("workspaces.overview.activity.actorActions.created");
  }
  switch (action) {
    case "create":
      return t("workspaces.overview.activity.actorActions.created");
    case "update":
      return t("workspaces.overview.activity.actorActions.updated");
    case "delete":
      return t("workspaces.overview.activity.actorActions.deleted");
    case "execute":
      return t("workspaces.overview.activity.actorActions.executed");
    case "review":
      return t("workspaces.overview.activity.actorActions.reviewed");
    case "cancel":
      return t("workspaces.overview.activity.actorActions.cancelled");
    default:
      return t("common.history");
  }
};

const ListItemTypeLabel = ({ value }: { value: ListItemType }) => {
  const t = useTranslations();
  return t(ITEM_TYPE_TRANSLATION_KEYS[value]);
};
