/**
 * The next steps for a claim the record does not cover, and what a re-check
 * changed. A gap is filled by a fact: added from a document with the passage
 * it rests on, or linked from the list, after which the claim is checked
 * again on its own. A claim that is waiting for the record says so with
 * "Needs evidence". A re-check keeps the run's verdict beside the new one.
 */

import * as React from "react";

import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { LIST_ITEM_TYPE } from "@stll/api-contract/entity-options";
import { createSearchQueryMatcher } from "@stll/text-normalize/search-query-matcher";
import { Temporal } from "@stll/time";
import { Button } from "@stll/ui/button";
import {
  Command,
  CommandInput,
  CommandItem,
  CommandList,
} from "@stll/ui/command";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import { Field, FieldError, FieldLabel } from "@stll/ui/field";
import { Form } from "@stll/ui/form";
import {
  ArrowRightIcon,
  FilePlusIcon,
  FileSearchIcon,
  LinkIcon,
  RefreshCwIcon,
  XIcon,
} from "@stll/ui/icons";
import { Input } from "@stll/ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "@stll/ui/popover";
import { ReviewStatusBadge } from "@stll/ui/review-status-badge";
import {
  Sheet,
  SheetFooter,
  SheetHeader,
  SheetPanel,
  SheetPopup,
  SheetTitle,
} from "@stll/ui/sheet";
import { Textarea } from "@stll/ui/textarea";

import { MatterDocumentPicker } from "@/components/workspaces/matter-document-picker";
import { isRecordSilent } from "@/features/avt/claim-qualifiers";
import { STATE_COLOR } from "@/features/avt/state-chip";
import type {
  ClaimRecheck,
  ClaimState,
  ListItem,
  VerificationClaim,
} from "@/features/avt/types";
import { STATE_META } from "@/features/avt/types";
import { useClaimGapActions } from "@/features/avt/use-claim-gap-actions";
import { useFormatter } from "@/i18n/formatting-context";
import { useMaybeAuthenticatedUser } from "@/lib/authenticated-user-context";
import { PDF_MIME } from "@/lib/consts";
import { detached } from "@/lib/detached";
import { queryView } from "@/lib/query-view.logic";
import { MEDIUM_DATE_SHORT_TIME_FORMAT } from "@/lib/relative-time";
import { useQueryViewError } from "@/lib/use-query-view";
import {
  entityOptions,
  workspaceFilesOptions,
} from "@/lib/workspaces/queries/entities";
import { legalListItemsOptions } from "@/lib/workspaces/queries/legal-lists";

/** Characters a list item's name may hold, the task endpoint's cap. */
const FACT_NAME_MAX_LENGTH = 255;

type GapScope = {
  workspaceId: string;
  runId: string;
  listId: string;
};

/** The list's facts a claim can be pointed at: held facts are never read. */
const useLinkableFacts = ({
  workspaceId,
  listId,
  enabled,
}: Pick<GapScope, "workspaceId" | "listId"> & { enabled: boolean }) => {
  // The list's items are read per viewer; with no signed-in viewer yet,
  // there is nothing to read them as.
  const user = useMaybeAuthenticatedUser();
  const query = useInfiniteQuery({
    ...legalListItemsOptions({
      workspaceId,
      listId,
      viewer: {
        userId: user?.id ?? "",
        organizationId: user?.activeOrganizationId ?? "",
      },
    }),
    enabled: enabled && user !== null,
  });
  const facts = (query.data?.pages ?? [])
    .flatMap((page) => page.items)
    .filter(
      (item) =>
        item.itemType === LIST_ITEM_TYPE.FACT &&
        item.factDetails?.scoring !== "held",
    );
  return { query, facts };
};

type GapActionsProps = GapScope & {
  claim: VerificationClaim;
  disabled: boolean;
  /** Marking the claim as needing evidence, offered here on a gap; null
   *  where the review decisions offer it instead. */
  needsEvidence: {
    marked: boolean;
    onChange: (marked: boolean) => void;
  } | null;
  /** Further quiet controls at the end of the row, if any. */
  more: React.ReactNode;
};

/**
 * A gap leads with its next steps. A silent record offers them only once
 * the reviewer opens them, since nothing is expected to be added.
 */
export const GapNextSteps = (props: GapActionsProps) => {
  const t = useTranslations();
  const [opened, setOpened] = React.useState(false);
  if (!isRecordSilent("nocover", props.claim) || opened) {
    return <GapActions {...props} />;
  }
  return (
    <Button
      aria-expanded={false}
      onClick={() => setOpened(true)}
      size="sm"
      variant="link"
    >
      {t("avt.gap.showNextSteps")}
    </Button>
  );
};

/** The ways out of a gap, under its one line: adding the fact leads, and
 *  linking one or marking the claim as needing evidence follow quietly. */
const GapActions = ({
  workspaceId,
  runId,
  listId,
  claim,
  disabled,
  needsEvidence,
  more,
}: GapActionsProps) => {
  const t = useTranslations();
  const actions = useClaimGapActions({
    workspaceId,
    runId,
    listId,
    claimId: claim.id,
  });
  const linked = new Set(claim.review?.linkedFactIds);
  const busy =
    disabled ||
    actions.addFact.isPending ||
    actions.link.isPending ||
    actions.recheck.isPending;
  return (
    <div className="flex flex-col items-start gap-1.5">
      <AddFactSheet
        claimText={claim.text}
        disabled={busy}
        onSubmit={async (input) => {
          await actions.addFact.mutateAsync(input);
        }}
        pending={actions.addFact.isPending}
        workspaceId={workspaceId}
      />
      <div className="flex flex-wrap items-center gap-1">
        <LinkFactPicker
          disabled={busy}
          linked={linked}
          listId={listId}
          onPick={(factEntityId) =>
            actions.link.mutate({ factEntityId, change: "link" })
          }
          pending={actions.link.isPending}
          workspaceId={workspaceId}
        />
        {needsEvidence !== null && (
          <Button
            aria-pressed={needsEvidence.marked}
            disabled={disabled}
            onClick={() => needsEvidence.onChange(!needsEvidence.marked)}
            size="sm"
            variant={needsEvidence.marked ? "secondary" : "ghost"}
          >
            <FileSearchIcon />
            {t("avt.review.status.needsEvidence")}
          </Button>
        )}
        {more}
      </div>
    </div>
  );
};

type LinkFactPickerProps = Pick<GapScope, "workspaceId" | "listId"> & {
  linked: ReadonlySet<string>;
  disabled: boolean;
  pending: boolean;
  onPick: (factEntityId: string) => void;
};

/** Search the list's facts and link one; arrows and Enter pick by key. */
const LinkFactPicker = ({
  workspaceId,
  listId,
  linked,
  disabled,
  pending,
  onPick,
}: LinkFactPickerProps) => {
  const t = useTranslations();
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const { query: facts, facts: linkable } = useLinkableFacts({
    workspaceId,
    listId,
    enabled: open,
  });
  const matches = createSearchQueryMatcher(query);
  const shown = linkable.filter(
    (fact) => !linked.has(fact.id) && matches(fact.name),
  );
  const changeOpen = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setQuery("");
    }
  };
  return (
    <Popover onOpenChange={changeOpen} open={open}>
      <PopoverTrigger
        disabled={disabled}
        render={<Button loading={pending} size="sm" variant="ghost" />}
      >
        <LinkIcon />
        {t("avt.gap.linkFact")}
      </PopoverTrigger>
      <PopoverPopup align="start" className="w-80" padding="none">
        <Command mode="none" onValueChange={setQuery} value={query}>
          <div className="border-b px-2.5 py-2">
            <CommandInput
              aria-label={t("avt.gap.searchFacts")}
              autoFocus
              placeholder={t("avt.gap.searchFacts")}
              size="sm"
            />
          </div>
          <CommandList>
            <div className="p-1">
              {facts.isPending ? (
                <p className="text-muted-foreground px-2 py-1.5 text-sm">
                  {t("common.loading")}
                </p>
              ) : null}
              {!facts.isPending && shown.length === 0 ? (
                <p className="text-muted-foreground px-2 py-1.5 text-sm">
                  {t("avt.gap.noFacts")}
                </p>
              ) : null}
              {shown.map((fact) => (
                <CommandItem
                  key={fact.id}
                  onClick={() => {
                    changeOpen(false);
                    onPick(fact.id);
                  }}
                  value={fact.id}
                >
                  <span className="line-clamp-2 min-w-0" dir="auto">
                    {fact.name}
                  </span>
                </CommandItem>
              ))}
              {facts.hasNextPage ? (
                <Button
                  className="w-full"
                  disabled={facts.isFetchingNextPage}
                  onClick={() =>
                    detached(facts.fetchNextPage(), "avt.link-fact-next-page")
                  }
                  size="sm"
                  variant="ghost"
                >
                  {facts.isFetchingNextPage
                    ? t("common.loading")
                    : t("common.loadMore")}
                </Button>
              ) : null}
            </div>
          </CommandList>
        </Command>
      </PopoverPopup>
    </Popover>
  );
};

type AddFactInput = Parameters<
  ReturnType<typeof useClaimGapActions>["addFact"]["mutateAsync"]
>[0];

type AddFactSheetProps = {
  workspaceId: string;
  claimText: string;
  disabled: boolean;
  pending: boolean;
  onSubmit: (input: AddFactInput) => Promise<void>;
};

/**
 * A side task beside the claim: the fact in the claim's words, the document
 * it comes from, and the passage that establishes it. Saving adds the fact,
 * links it to the claim and checks the claim again.
 */
const AddFactSheet = ({
  workspaceId,
  claimText,
  disabled,
  pending,
  onSubmit,
}: AddFactSheetProps) => {
  const t = useTranslations();
  const [open, setOpen] = React.useState(false);
  return (
    <Sheet onOpenChange={setOpen} open={open}>
      <Button
        disabled={disabled}
        loading={pending}
        onClick={() => setOpen(true)}
        size="sm"
      >
        <FilePlusIcon />
        {t("avt.gap.addFact")}
      </Button>
      {open && (
        <SheetPopup side="inline-end">
          <SheetHeader>
            <SheetTitle>{t("avt.gap.sheet.title")}</SheetTitle>
          </SheetHeader>
          <AddFactForm
            claimText={claimText}
            onCancel={() => setOpen(false)}
            onSubmit={async (input) => {
              await onSubmit(input);
              setOpen(false);
            }}
            pending={pending}
            workspaceId={workspaceId}
          />
        </SheetPopup>
      )}
    </Sheet>
  );
};

type AddFactFormProps = {
  workspaceId: string;
  claimText: string;
  pending: boolean;
  onCancel: () => void;
  onSubmit: (input: AddFactInput) => Promise<void>;
};

type FormErrors = Partial<Record<"statement" | "document" | "page", string>>;

const AddFactForm = ({
  workspaceId,
  claimText,
  pending,
  onCancel,
  onSubmit,
}: AddFactFormProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const queryClient = useQueryClient();
  const filesView = queryView(useQuery(workspaceFilesOptions(workspaceId)));
  useQueryViewError(filesView, "AddFactFromDocument:query");
  const files = filesView.type === "items" ? filesView.items : [];
  // Prefilled with the claim's words; the reviewer trims it to the fact.
  const [statement, setStatement] = React.useState(claimText);
  const [documentId, setDocumentId] = React.useState("");
  const [page, setPage] = React.useState("");
  const [quote, setQuote] = React.useState("");
  const [errors, setErrors] = React.useState<FormErrors>({});
  const isPdf =
    files.find((file) => file.entityId === documentId)?.mimeType === PDF_MIME;

  const validate = (): FormErrors => {
    const trimmed = statement.trim();
    return {
      ...(trimmed === "" && {
        statement: t("avt.gap.sheet.statementRequired"),
      }),
      ...(trimmed.length > FACT_NAME_MAX_LENGTH && {
        statement: t("avt.gap.sheet.statementTooLong", {
          limit: format.number(FACT_NAME_MAX_LENGTH),
        }),
      }),
      ...(documentId === "" && {
        document: t("lists.sources.documentRequired"),
      }),
      ...(isPdf &&
        page !== "" &&
        !(Number.isSafeInteger(Number(page)) && Number(page) >= 1) && {
          page: t("lists.sources.invalidPage"),
        }),
    };
  };

  const submit = async () => {
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length > 0) {
      return;
    }
    // Resolve the live version at submission rather than a stale pick.
    const document = await queryClient.query({
      ...entityOptions(workspaceId, documentId),
      staleTime: 0,
    });
    await onSubmit({
      statement: statement.trim(),
      source: {
        sourceEntityId: document.entityId,
        sourceEntityVersionId: document.currentVersionId,
        pageNumber: isPdf && page !== "" ? Number(page) : null,
        quote: quote.trim() === "" ? null : quote.trim(),
      },
    });
  };

  return (
    <Form
      className="contents"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (!pending) {
          detached(submit(), "avt.add-fact-from-document");
        }
      }}
    >
      <SheetPanel>
        <div className="flex flex-col gap-4">
          <Field invalid={errors.statement !== undefined} name="statement">
            <FieldLabel>{t("common.fact")}</FieldLabel>
            <Textarea
              disabled={pending}
              onChange={(event) => setStatement(event.target.value)}
              value={statement}
            />
            <FieldError match={errors.statement !== undefined} role="alert">
              {errors.statement}
            </FieldError>
          </Field>
          <Field invalid={errors.document !== undefined} name="document">
            <MatterDocumentPicker
              disabled={pending}
              label={t("common.document")}
              maxPicked={1}
              onChange={(ids) => {
                setDocumentId(ids.at(0) ?? "");
                setPage("");
              }}
              pickedEntityIds={documentId === "" ? [] : [documentId]}
              workspaceId={workspaceId}
            />
            <FieldError match={errors.document !== undefined} role="alert">
              {errors.document}
            </FieldError>
          </Field>
          {isPdf && (
            <Field invalid={errors.page !== undefined} name="page">
              <FieldLabel>{t("lists.sources.page")}</FieldLabel>
              <Input
                dir="ltr"
                disabled={pending}
                inputMode="numeric"
                onChange={(event) => setPage(event.target.value)}
                value={page}
              />
              <FieldError match={errors.page !== undefined} role="alert">
                {errors.page}
              </FieldError>
            </Field>
          )}
          <Field name="passage">
            <FieldLabel>{t("avt.gap.sheet.passage")}</FieldLabel>
            <Textarea
              disabled={pending}
              onChange={(event) => setQuote(event.target.value)}
              placeholder={t("avt.gap.sheet.passageHint")}
              value={quote}
            />
          </Field>
        </div>
      </SheetPanel>
      <SheetFooter>
        <Button
          disabled={pending}
          onClick={onCancel}
          type="button"
          variant="ghost"
        >
          {t("common.cancel")}
        </Button>
        <Button loading={pending} type="submit">
          {t("avt.gap.sheet.submit")}
        </Button>
      </SheetFooter>
    </Form>
  );
};

type LinkedFactsProps = GapScope & {
  claim: VerificationClaim;
  disabled: boolean;
};

/**
 * The facts a reviewer pointed the claim at, each removable, and a re-check
 * that reads them again. Shown while any are linked, whatever the verdict.
 */
export const LinkedFacts = ({
  workspaceId,
  runId,
  listId,
  claim,
  disabled,
}: LinkedFactsProps) => {
  const t = useTranslations();
  const linkedIds = claim.review?.linkedFactIds ?? [];
  const { facts } = useLinkableFacts({
    workspaceId,
    listId,
    enabled: linkedIds.length > 0,
  });
  const actions = useClaimGapActions({
    workspaceId,
    runId,
    listId,
    claimId: claim.id,
  });
  if (linkedIds.length === 0) {
    return null;
  }
  const names = new Map<string, ListItem["name"]>(
    facts.map((fact) => [fact.id, fact.name]),
  );
  const busy = disabled || actions.link.isPending || actions.recheck.isPending;
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-muted-foreground text-xs font-bold tracking-wide uppercase">
          {t("avt.gap.linked")}
        </h3>
        <Button
          disabled={busy}
          loading={actions.recheck.isPending}
          onClick={() => actions.recheck.mutate()}
          size="sm"
          variant="ghost"
        >
          <RefreshCwIcon />
          {t("avt.gap.recheck")}
        </Button>
      </div>
      <ul className="divide-y rounded-md border">
        {linkedIds.map((factId) => {
          const name = names.get(factId) ?? t("avt.gap.factOffList");
          return (
            <li className="flex items-start gap-2 p-2 ps-3" key={factId}>
              <span
                className="min-w-0 flex-1 text-sm leading-relaxed"
                dir="auto"
              >
                {name}
              </span>
              <Button
                aria-label={t("avt.gap.unlink", { fact: name })}
                disabled={busy}
                onClick={() =>
                  actions.link.mutate({
                    factEntityId: factId,
                    change: "unlink",
                  })
                }
                size="icon-sm"
                variant="ghost"
              >
                <XIcon />
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
};

type RecheckSummaryProps = {
  recheck: ClaimRecheck;
  state: ClaimState;
};

/** When the claim was checked again and against how many facts, with the
 *  verdict the run gave beside the one it reads with now. */
export const RecheckSummary = ({ recheck, state }: RecheckSummaryProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const checkedAt = format.dateTime(
    Temporal.Instant.from(recheck.checkedAt).epochMilliseconds,
    MEDIUM_DATE_SHORT_TIME_FORMAT,
  );
  const original = recheck.original.verdict.state;
  return (
    <div className="bg-muted/60 flex flex-col gap-1.5 rounded-md p-3">
      <p className="text-muted-foreground flex items-start gap-1.5 text-xs leading-relaxed">
        <RefreshCwIcon
          aria-hidden="true"
          className="mt-0.5 size-3.5 shrink-0"
        />
        {t("avt.recheck.summary", {
          checkedAt,
          count: recheck.factCount,
        })}
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="sr-only">{t("avt.recheck.runVerdict")}</span>
        <ReviewStatusBadge tone={STATE_COLOR[original].tone}>
          {t(STATE_META[original].chipKey)}
        </ReviewStatusBadge>
        <DirectionalIcon
          className="text-muted-foreground size-3"
          icon={ArrowRightIcon}
        />
        <span className="sr-only">{t("avt.recheck.currentVerdict")}</span>
        <ReviewStatusBadge tone={STATE_COLOR[state].tone}>
          {t(STATE_META[state].chipKey)}
        </ReviewStatusBadge>
      </div>
    </div>
  );
};
