import {
  Suspense,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import type { Editor } from "@tiptap/react";
import { Result } from "better-result";
import { KeyboardIcon, PlusIcon, RouteIcon, XIcon } from "lucide-react";
import { useFormatter, useTranslations } from "use-intl";

import { PROPERTY_DEPENDENCIES_PER_PROPERTY_MAX } from "@stll/api-contract";
import { Button } from "@stll/ui/button";
import {
  Dialog,
  DialogClose,
  DialogFooter,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "@stll/ui/dialog";
import { Input } from "@stll/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";
import { Skeleton } from "@stll/ui/skeleton";
import { stellaToast } from "@stll/ui/toast";
import { cn } from "@stll/ui/utils";

import { AiRewriteControl } from "@/components/ai-rewrite-control";
import Tooltip from "@/components/tooltip";
import {
  makeEmptyDraft,
  questionColumnContent,
  questionDraft,
  settleColumnWrites,
} from "@/components/workspaces/bulk-add-columns.logic";
import type { Draft } from "@/components/workspaces/bulk-add-columns.logic";
import { usePropertiesCountLimit } from "@/components/workspaces/hooks/use-limits";
import { useStartWorkflow } from "@/components/workspaces/hooks/use-start-workflow";
import {
  COMPOSER_CARD_CLASS,
  ReadingFromRow,
  TypeChipsRow,
  useChipDefinitions,
} from "@/components/workspaces/properties/composer-primitives";
import type {
  FileChip,
  ManualChipOption,
} from "@/components/workspaces/properties/composer-primitives";
import { InlineOptionEditor } from "@/components/workspaces/properties/inline-option-editor";
import { PropertyPromptInput } from "@/components/workspaces/properties/property-input/input";
import type { PropertyPromptFieldHandle } from "@/components/workspaces/properties/property-input/input";
import { ADD_COLUMN_RAIL_PLUS_CLASS_NAME } from "@/components/workspaces/table/add-column-rail";
import {
  buildDocTypeGate,
  resolveDocumentTypeClassifier,
} from "@/components/workspaces/table/group-columns";
import {
  createQuestionColumn,
  questionColumnKeys,
  suggestQuestionPrompt,
  updateQuestionColumn,
} from "@/features/case-law/research/queries";
import { questionEditDiscardsAnswers } from "@/features/case-law/research/question-columns.logic";
import type {
  QuestionColumn,
  QuestionColumnInput,
  QuestionSuggestionScope,
} from "@/features/case-law/research/question-columns.logic";
import { useQuestionColumnsCountLimit } from "@/features/case-law/research/use-question-column-limit";
import { guideAnchor } from "@/features/guides/guide-anchor";
import { GUIDE_ANCHORS } from "@/features/guides/guide-anchors";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { getAnalytics } from "@/lib/analytics/provider";
import { detached } from "@/lib/detached";
import { toSafeId } from "@/lib/safe-id";
import type { PropertyDependency } from "@/lib/types";
import {
  suggestPropertyPrompt,
  useCreatePropertiesBatch,
} from "@/lib/workspaces/mutations/properties";
import type { CreatePropertySpec } from "@/lib/workspaces/mutations/properties";
import { propertiesOptions } from "@/lib/workspaces/queries/properties";

// Sentinel for the "every document type" (ungated) scope; a Select value can't
// be null, so it stands in and maps back to null.
const SCOPE_ALL_VALUE = "__all__";

type DraftScopeGate = {
  classifier: { id: string } | null;
  scopeDocType: string | null;
};

/**
 * The dependency list one AI draft creates. The scope gate owns the classifier
 * slot only when a specific document type is selected: drop the classifier
 * there and append the gate. With scope "All" an explicit classifier mention
 * stays a normal dependency.
 */
const draftDependencies = (
  draft: Pick<Draft, "fileIds" | "mentions">,
  { classifier, scopeDocType }: DraftScopeGate,
): PropertyDependency[] => {
  const dependencyIds = [
    ...new Set([...draft.fileIds, ...draft.mentions]),
  ].filter((id) => scopeDocType === null || id !== classifier?.id);
  const dependencies: PropertyDependency[] = dependencyIds.map((id) => ({
    dependsOnPropertyId: toSafeId<"property">(id),
    condition: null,
  }));
  if (classifier && scopeDocType !== null) {
    dependencies.push(buildDocTypeGate(classifier.id, scopeDocType));
  }
  return dependencies;
};

type TriggerVariant = "icon" | "labelled" | "rail" | "none";

/**
 * Which set of columns the dialog adds to.
 *
 * One body, two owners: a matter's properties, which read the matter's files
 * and may be gated to a document type, and an organization's case-law question
 * columns, which are asked of a public decision and so have neither. The
 * target decides the mutation, the cap, and which of the two extra controls
 * apply; everything the reader types is the same.
 */
type AddColumnsTarget =
  | { kind: "workspace"; workspaceId: string }
  | {
      kind: "organisation";
      /**
       * The question being reworded, when the dialog was opened from a
       * column's own menu. One card then, seeded from the question, saved back
       * over it — the composer is the same one a new question is written in.
       */
      editing?: QuestionColumn | undefined;
      /** The search the questions are asked of; grounds the suggestion. */
      suggestion: QuestionSuggestionScope;
      /**
       * Shows the created questions on that search. Absent where nothing is
       * created: a rewording, and the account gate that holds the dialog shut.
       */
      onCreated?: ((columnIds: readonly string[]) => void) | undefined;
    };

type BulkAddColumnsProps = {
  target: AddColumnsTarget;
  triggerVariant?: TriggerVariant;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

export const BulkAddColumns = ({
  target,
  triggerVariant = "icon",
  open,
  onOpenChange,
}: BulkAddColumnsProps) => {
  const t = useTranslations();
  const isLimitReached = useAddColumnsLimit(target);
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const [flashClose, setFlashClose] = useState(false);
  const dirtyRef = useRef(false);
  // Set to true by the X button click handler immediately before
  // it triggers onOpenChange(false). The dirty guard sees this flag,
  // resets it, and lets the close through — Esc / backdrop clicks
  // never set it, so they still get the flash treatment.
  const explicitCloseRef = useRef(false);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dialogOpen = open ?? uncontrolledOpen;
  const setDialogOpen = (next: boolean) => {
    onOpenChange?.(next);
    if (open === undefined) {
      setUncontrolledOpen(next);
    }
  };

  const triggerFlash = useCallback(() => {
    if (flashTimerRef.current !== null) {
      clearTimeout(flashTimerRef.current);
    }
    setFlashClose(true);
    flashTimerRef.current = setTimeout(() => {
      setFlashClose(false);
      flashTimerRef.current = null;
    }, 700);
  }, []);

  if (isLimitReached) {
    return null;
  }

  return (
    <Dialog
      onOpenChange={(nextOpen) => {
        if (!nextOpen && dirtyRef.current && !explicitCloseRef.current) {
          triggerFlash();
          return;
        }
        explicitCloseRef.current = false;
        setDialogOpen(nextOpen);
      }}
      open={dialogOpen}
    >
      <BulkTrigger triggerVariant={triggerVariant} />
      <DialogPopup className="sm:max-w-[640px]" showCloseButton={false}>
        <DialogClose
          aria-label={t("common.close")}
          className={cn(
            "absolute end-2 top-2 z-10 transition-[transform,box-shadow,background-color] duration-200",
            flashClose &&
              "bg-muted ring-foreground-strong-muted scale-125 ring-2",
          )}
          onClick={() => {
            explicitCloseRef.current = true;
          }}
          render={<Button size="icon" variant="ghost" />}
        >
          <XIcon />
        </DialogClose>
        {dialogOpen && (
          <Suspense fallback={<BulkBodyFallback />}>
            <BulkBody
              dirtyRef={dirtyRef}
              onClose={() => setDialogOpen(false)}
              target={target}
            />
          </Suspense>
        )}
      </DialogPopup>
    </Dialog>
  );
};

type BulkTriggerProps = { triggerVariant: TriggerVariant };

const BulkTrigger = ({ triggerVariant }: BulkTriggerProps) => {
  const t = useTranslations();
  if (triggerVariant === "labelled") {
    return (
      <DialogTrigger
        render={
          <Button
            aria-label={t("workspaces.properties.newColumn")}
            className="gap-1"
            size="xs"
            title={t("workspaces.properties.newColumn")}
            type="button"
            variant="muted"
            {...guideAnchor(GUIDE_ANCHORS.tabularReviewAddColumn)}
          />
        }
      >
        <PlusIcon className="size-3" />
        <span className="hidden sm:inline">
          {t("workspaces.properties.newColumn")}
        </span>
      </DialogTrigger>
    );
  }
  if (triggerVariant === "icon") {
    return (
      <Tooltip
        content={t("workspaces.properties.newColumn")}
        render={
          <DialogTrigger
            render={
              <button
                aria-label={t("workspaces.properties.newColumn")}
                className="ring-ring focus-visible:ring-offset-background text-muted-foreground flex h-full w-full cursor-pointer items-center justify-center border-0 bg-transparent p-0 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-offset-1"
                data-add-property-trigger
                data-row-expansion-ignore
                onClick={(event) => event.currentTarget.blur()}
                type="button"
              />
            }
          />
        }
      >
        <PlusIcon className="size-4" />
      </Tooltip>
    );
  }
  if (triggerVariant === "rail") {
    return (
      <Tooltip
        content={t("workspaces.properties.newColumn")}
        render={
          <DialogTrigger
            render={
              <button
                aria-label={t("workspaces.properties.newColumn")}
                className="group/add-column-rail ring-ring focus-visible:ring-offset-background absolute inset-0 z-10 cursor-pointer border-0 bg-transparent p-0 outline-none focus-visible:ring-2 focus-visible:ring-offset-1"
                data-add-property-trigger
                data-row-expansion-ignore
                onClick={(event) => event.currentTarget.blur()}
                type="button"
              />
            }
          />
        }
      >
        <PlusIcon className={ADD_COLUMN_RAIL_PLUS_CLASS_NAME} />
      </Tooltip>
    );
  }
  return null;
};

const BulkBodyFallback = () => (
  <div className="space-y-3 p-5">
    <Skeleton className="h-5 w-24" />
    <Skeleton className="h-32 w-full" />
  </div>
);

type BulkBodyProps = {
  target: AddColumnsTarget;
  onClose: () => void;
  dirtyRef: React.RefObject<boolean>;
};

const BulkBody = ({ target, onClose, dirtyRef }: BulkBodyProps) => {
  if (target.kind === "organisation") {
    return (
      <QuestionColumnsBody
        dirtyRef={dirtyRef}
        {...(target.editing === undefined ? {} : { editing: target.editing })}
        onClose={onClose}
        {...(target.onCreated === undefined
          ? {}
          : { onCreated: target.onCreated })}
        suggestion={target.suggestion}
      />
    );
  }
  return (
    <PropertyColumnsBody
      dirtyRef={dirtyRef}
      onClose={onClose}
      workspaceId={target.workspaceId}
    />
  );
};

/** The cap the target enforces, so the trigger disappears at it. */
const useAddColumnsLimit = (target: AddColumnsTarget): boolean => {
  // Both hooks run on every render, but only the target's own read is
  // enabled: the other has no workspace or organization to count, and asking
  // anyway spends a request per trigger drawn.
  const workspaceLimitReached = usePropertiesCountLimit(
    target.kind === "workspace" ? target.workspaceId : null,
  );
  const organisationLimitReached = useQuestionColumnsCountLimit(
    target.kind === "organisation",
  );

  return target.kind === "workspace"
    ? workspaceLimitReached
    : organisationLimitReached;
};

type DraftHandlers = {
  canRemove: boolean;
  onChange: (patch: Partial<Draft>) => void;
  onRemove: () => void;
};

/** The drafts a reader is composing, and what they may do to one. */
const useColumnDrafts = (defaultFileIds: string[], seed?: Draft) => {
  const [drafts, setDrafts] = useState<Draft[]>(() => [
    seed ?? makeEmptyDraft(0, defaultFileIds),
  ]);
  const nextId = useNextId(drafts.length);

  const updateDraft = useCallback((id: number, patch: Partial<Draft>) => {
    setDrafts((prev) =>
      prev.map((d) => (d.id === id ? { ...d, ...patch } : d)),
    );
  }, []);

  const removeDraft = useCallback((id: number) => {
    setDrafts((prev) =>
      prev.length === 1 ? prev : prev.filter((d) => d.id !== id),
    );
  }, []);

  const addDraft = useCallback(() => {
    setDrafts((prev) => [...prev, makeEmptyDraft(nextId(), defaultFileIds)]);
  }, [defaultFileIds, nextId]);

  const validDrafts = useMemo(
    () => drafts.filter((d) => d.name.trim().length > 0),
    [drafts],
  );
  const isDirty = useMemo(
    () =>
      drafts.some(
        (d) => d.name.trim().length > 0 || d.prompt.trim().length > 0,
      ),
    [drafts],
  );

  const handlersFor = (draft: Draft): DraftHandlers => ({
    canRemove: drafts.length > 1,
    onChange: (patch) => updateDraft(draft.id, patch),
    onRemove: () => removeDraft(draft.id),
  });

  return { addDraft, drafts, handlersFor, isDirty, validDrafts };
};

type BulkColumnsFormProps = React.PropsWithChildren<{
  canSubmit: boolean;
  /** The matter's document-type gate; the organization's columns have none. */
  footerExtra?: React.ReactNode;
  isPending: boolean;
  /** Omitted while one existing column is being reworded. */
  onAddDraft?: (() => void) | undefined;
  onSubmit: () => void;
}>;

/** The dialog's chrome: the title, the drafts, the gate and the two buttons. */
const BulkColumnsForm = ({
  canSubmit,
  children,
  footerExtra,
  isPending,
  onAddDraft,
  onSubmit,
}: BulkColumnsFormProps) => {
  const t = useTranslations();

  return (
    <>
      <header className="flex items-center gap-2 px-5 pt-4 pb-3">
        <DialogTitle className="flex-1 text-base leading-tight font-semibold">
          {t("workspaces.properties.bulk.title")}
        </DialogTitle>
      </header>

      <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto px-5 pt-1 pb-2">
        {children}
        {onAddDraft !== undefined && (
          <Button
            className="text-foreground-label hover:text-foreground hover:bg-accent w-fit gap-1 px-2 font-normal"
            onClick={onAddDraft}
            size="xs"
            type="button"
            variant="ghost"
          >
            <PlusIcon className="size-3" />
            {t("workspaces.properties.bulk.addAnother")}
          </Button>
        )}
      </div>

      <DialogFooter className="px-5 py-3 sm:items-center sm:justify-between">
        {footerExtra ?? <span />}
        <div className="flex items-center gap-2">
          <DialogClose render={<Button size="sm" variant="ghost" />}>
            {t("common.cancel")}
          </DialogClose>
          <Button
            disabled={!canSubmit}
            loading={isPending}
            onClick={onSubmit}
            size="sm"
          >
            {t("workspaces.properties.bulk.title")}
          </Button>
        </div>
      </DialogFooter>
    </>
  );
};

/**
 * Runs one target's create, says what happened, and closes on success. Both
 * targets go through it, so a failure is never silent and neither body keeps a
 * boundary of its own.
 */
const useColumnsSubmit = (onClose: () => void) => {
  const t = useTranslations();

  return async ({
    count,
    run,
  }: {
    count: number;
    run: () => Promise<Result<void, Error>>;
  }) => {
    const created = await run();
    if (Result.isError(created)) {
      getAnalytics().captureError(created.error);
      stellaToast.add({
        title: t("workspaces.properties.bulk.createFailed"),
        type: "error",
      });
      return;
    }
    stellaToast.add({
      title:
        count === 1
          ? t("workspaces.properties.bulk.createdOne")
          : t("workspaces.properties.bulk.createdMany", {
              count: String(count),
            }),
      type: "success",
    });
    onClose();
  };
};

type ColumnsBodyProps = {
  onClose: () => void;
  dirtyRef: React.RefObject<boolean>;
};

const PropertyColumnsBody = ({
  workspaceId,
  onClose,
  dirtyRef,
}: ColumnsBodyProps & { workspaceId: string }) => {
  const t = useTranslations();
  const submit = useColumnsSubmit(onClose);
  const batch = useCreatePropertiesBatch({ workspaceId });
  const startWorkflow = useStartWorkflow(workspaceId);
  const { data: properties } = useSuspenseQuery(propertiesOptions(workspaceId));

  const fileProperties = useMemo<FileChip[]>(
    () =>
      properties.flatMap((p) =>
        p.content.type === "file" ? [{ id: p.id, name: p.name }] : [],
      ),
    [properties],
  );
  const allProperties = useMemo<FileChip[]>(
    () => properties.map((p) => ({ id: p.id, name: p.name })),
    [properties],
  );
  const defaultFileIds = useMemo(
    () => fileProperties.map((p) => p.id),
    [fileProperties],
  );

  // Shared "applies to" scope: gate every AI column added here to one document
  // type (or all). Offered only when a Document Type classifier exists.
  const classifier = useMemo(
    () => resolveDocumentTypeClassifier(properties),
    [properties],
  );
  const docTypeOptions =
    classifier?.content.type === "single-select"
      ? classifier.content.options
      : [];
  const [scopeDocType, setScopeDocType] = useState<string | null>(null);

  const { addDraft, drafts, handlersFor, isDirty, validDrafts } =
    useColumnDrafts(defaultFileIds);

  const dependencyCountOf = (draft: Draft) =>
    draft.tool === "ai-model"
      ? draftDependencies(draft, { classifier, scopeDocType }).length
      : 0;
  const withinDependencyCap = validDrafts.every(
    (draft) =>
      dependencyCountOf(draft) <= PROPERTY_DEPENDENCIES_PER_PROPERTY_MAX,
  );
  const canSubmit =
    validDrafts.length > 0 && withinDependencyCap && !batch.isPending;

  // The dialog's onOpenChange close guard reads dirtiness off the
  // parent-owned ref at close time; mirror it after commit so the
  // compiler can model this component.
  useLayoutEffect(() => {
    dirtyRef.current = isDirty;
  });

  const handleSubmit = async () => {
    if (!canSubmit) {
      return;
    }
    const items: CreatePropertySpec[] = validDrafts.map((d) => {
      const isSelectType =
        d.contentType === "single-select" || d.contentType === "multi-select";
      const includeOptions = isSelectType && d.options.length > 0;
      const item: CreatePropertySpec = {
        name: d.name.trim(),
        contentType: d.contentType,
        toolType: d.tool,
      };
      if (d.tool === "ai-model") {
        item.prompt = d.prompt;
        const dependencies = draftDependencies(d, { classifier, scopeDocType });
        if (dependencies.length > 0) {
          item.dependencies = dependencies;
        }
      }
      if (includeOptions) {
        item.options = d.options;
        item.fallback = d.fallback;
      }
      return item;
    });
    await submit({
      count: items.length,
      run: async () =>
        await Result.tryPromise({
          try: async () => {
            await batch.mutateAsync({ items });
            // Created columns with AI prompts need a workflow run for the
            // extraction to actually populate cells; manual columns don't.
            // Same convention the single-column dialog uses.
            if (items.some((item) => item.toolType === "ai-model")) {
              detached(startWorkflow(), "bulk-add-columns.start-workflow");
            }
          },
          catch: (cause) =>
            cause instanceof Error ? cause : new Error(String(cause)),
        }),
    });
  };

  return (
    <BulkColumnsForm
      canSubmit={canSubmit}
      footerExtra={
        classifier && docTypeOptions.length > 0 ? (
          <div className="flex min-w-0 items-center gap-2">
            <RouteIcon className="text-muted-foreground size-4 shrink-0" />
            <span className="text-muted-foreground shrink-0 text-sm">
              {classifier.name}
            </span>
            <Select
              onValueChange={(next) =>
                setScopeDocType(
                  next === null || next === SCOPE_ALL_VALUE ? null : next,
                )
              }
              value={scopeDocType ?? SCOPE_ALL_VALUE}
            >
              <SelectTrigger className="h-7 min-h-0 w-auto min-w-36" size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value={SCOPE_ALL_VALUE}>
                  {t("common.all")}
                </SelectItem>
                {docTypeOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.value}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
        ) : undefined
      }
      isPending={batch.isPending}
      onAddDraft={addDraft}
      onSubmit={() => {
        detached(handleSubmit(), "bulk-add-columns.submit");
      }}
    >
      {drafts.map((draft) => (
        <DraftCard
          {...handlersFor(draft)}
          draft={draft}
          key={draft.id}
          target={{
            kind: "workspace",
            allProperties,
            dependencyCount: dependencyCountOf(draft),
            workspaceId,
          }}
        />
      ))}
    </BulkColumnsForm>
  );
};

const NO_DEFAULT_FILE_IDS: string[] = [];

/**
 * The organization's case-law question columns. A question is asked of a
 * public decision, so there is no matter file to read from, no prompt beside
 * the wording and no document type to gate on: the card is the question, the
 * kind of answer, and a select's options.
 */
const QuestionColumnsBody = ({
  editing,
  onClose,
  onCreated,
  dirtyRef,
  suggestion,
}: ColumnsBodyProps & {
  editing?: QuestionColumn | undefined;
  onCreated?: ((columnIds: readonly string[]) => void) | undefined;
  suggestion: QuestionSuggestionScope;
}) => {
  const t = useTranslations();
  const submit = useColumnsSubmit(onClose);
  const queryClient = useQueryClient();
  const { addDraft, drafts, handlersFor, isDirty, validDrafts } =
    useColumnDrafts(
      NO_DEFAULT_FILE_IDS,
      editing === undefined ? undefined : questionDraft(editing),
    );

  const save = useMutation({
    mutationFn: async (inputs: readonly QuestionColumnInput[]) => {
      // Indexed by draft, so the columns join the search in the order they
      // were written whichever request answers first.
      const createdIds: (string | undefined)[] = inputs.map(() => undefined);
      // The requests name disjoint columns, so they go together rather than
      // one round trip after another; they settle, so whatever committed is
      // read back before the failure is reported.
      const settled = await settleColumnWrites({
        writes: inputs.map((input, index) => async () => {
          if (editing !== undefined) {
            await updateQuestionColumn({ ...input, columnId: editing.id });
            return;
          }
          createdIds[index] = (await createQuestionColumn(input)).id;
        }),
        refresh: async () => {
          await queryClient.invalidateQueries({
            queryKey: questionColumnKeys.all,
          });
        },
      });
      // A column that landed is shown even when another draft was refused.
      const created = createdIds.filter((columnId) => columnId !== undefined);
      if (created.length > 0) {
        onCreated?.(created);
      }
      return settled;
    },
  });
  const canSubmit = validDrafts.length > 0 && !save.isPending;

  useLayoutEffect(() => {
    dirtyRef.current = isDirty;
  });

  const inputs = validDrafts.map((draft) => ({
    question: draft.name.trim(),
    content: questionColumnContent(draft),
  }));
  const firstInput = inputs.at(0);
  const discardsAnswers =
    editing !== undefined &&
    firstInput !== undefined &&
    questionEditDiscardsAnswers({ draft: firstInput, stored: editing });

  const handleSubmit = async () => {
    if (!canSubmit) {
      return;
    }
    await submit({
      count: inputs.length,
      run: async () => await save.mutateAsync(inputs),
    });
  };

  return (
    <BulkColumnsForm
      canSubmit={canSubmit}
      {...(discardsAnswers
        ? {
            footerExtra: (
              <p className="text-muted-foreground text-xs" role="alert">
                {t("caseLaw.research.editQuestionHint")}
              </p>
            ),
          }
        : {})}
      isPending={save.isPending}
      {...(editing === undefined ? { onAddDraft: addDraft } : {})}
      onSubmit={() => {
        detached(handleSubmit(), "bulk-add-columns.submit");
      }}
    >
      {drafts.map((draft) => (
        <DraftCard
          {...handlersFor(draft)}
          draft={draft}
          key={draft.id}
          target={{ kind: "organisation", suggestion }}
        />
      ))}
    </BulkColumnsForm>
  );
};

const useNextId = (initial: number) => {
  const ref = useRef(initial);
  return useCallback(() => {
    ref.current += 1;
    return ref.current;
  }, []);
};

/**
 * What one card is composing, and therefore what it offers beside the name.
 *
 * A matter's column may read the matter's other columns, so it carries them,
 * the prompt that reads them, and the cap on how many one column may read. A
 * question is asked of a public decision and reads nothing else, so it carries
 * the search it is written for instead — which is all its suggestion needs.
 */
type DraftCardTarget =
  | {
      kind: "workspace";
      allProperties: FileChip[];
      /** Dependencies this draft would create, scope gate included. */
      dependencyCount: number;
      workspaceId: string;
    }
  | { kind: "organisation"; suggestion: QuestionSuggestionScope };

type DraftCardProps = DraftHandlers & {
  draft: Draft;
  target: DraftCardTarget;
};

const NO_FILE_CHIPS: FileChip[] = [];

const DraftCard = ({
  draft,
  canRemove,
  target,
  onChange,
  onRemove,
}: DraftCardProps) => {
  const isWorkspace = target.kind === "workspace";
  const allProperties = isWorkspace ? target.allProperties : NO_FILE_CHIPS;
  const dependencyCount = isWorkspace ? target.dependencyCount : 0;
  const workspaceId = isWorkspace ? target.workspaceId : "";
  const t = useTranslations();
  const format = useFormatter();
  const chipDefs = useChipDefinitions();
  const editorRef = useRef<Editor | null>(null);
  const [initialPrompt] = useState(() => draft.prompt);
  const handlePromptChange = useLatestCallback((next: string) => {
    onChange({ prompt: next });
  });

  const promptField: PropertyPromptFieldHandle = useMemo(
    () => ({
      name: `draft-${draft.id}`,
      state: { value: initialPrompt },
      handleChange: handlePromptChange,
      handleBlur: () => undefined,
    }),
    [draft.id, handlePromptChange, initialPrompt],
  );

  const handleMentions = useCallback(
    (mentions: string[]) => {
      onChange({ mentions });
    },
    [onChange],
  );

  const handleEditorReady = useCallback((editor: Editor) => {
    editorRef.current = editor;
  }, []);

  const trimmedName = draft.name.trim();
  const isAi = draft.tool === "ai-model" && isWorkspace;

  /**
   * One suggestion affordance, two things a column can be asked of: a matter's
   * documents, or the decisions the reader's current search returned. The
   * target decides which endpoint answers and where the wording lands — a
   * matter column's prompt, or the question itself, which is all a question
   * column has.
   */
  const suggestPrompt = useMutation({
    mutationFn: async (instruction: string) =>
      target.kind === "workspace"
        ? await suggestPropertyPrompt({
            workspaceId: target.workspaceId,
            name: trimmedName,
            contentType: draft.contentType,
            instruction,
          })
        : await suggestQuestionPrompt({
            draft: {
              question: trimmedName,
              content: questionColumnContent(draft),
            },
            instruction,
            scope: target.suggestion,
          }),
    onError: (error) => {
      getAnalytics().captureError(error);
      stellaToast.add({
        title: t("workspaces.properties.autoPromptFailed"),
        type: "error",
      });
    },
  });

  const suggestDisabled = trimmedName.length === 0 || suggestPrompt.isPending;
  const autoPromptDisabled = !isAi || suggestDisabled;

  const applySuggestion = (suggested: string) => {
    if (target.kind === "organisation") {
      onChange({ name: suggested });
      return;
    }
    const editor = editorRef.current;
    if (!editor || editor.isDestroyed) {
      onChange({ prompt: suggested });
      return;
    }
    editor.commands.setContent(suggested);
    onChange({ prompt: editor.getHTML() });
  };

  const handleAutoPrompt = (instruction: string) => {
    if (suggestDisabled) {
      return;
    }
    suggestPrompt.mutate(instruction, {
      onSuccess: ({ prompt: suggested }) => applySuggestion(suggested),
    });
  };

  const sourceIds = useMemo(
    () => [...new Set([...draft.fileIds, ...draft.mentions])],
    [draft.fileIds, draft.mentions],
  );
  const selectedFiles = useMemo(
    () =>
      sourceIds.flatMap((id) => {
        const found = allProperties.find((p) => p.id === id);
        return found ? [found] : [];
      }),
    [sourceIds, allProperties],
  );
  const availableFiles = allProperties.filter((p) => !sourceIds.includes(p.id));
  const needsOptions =
    draft.contentType === "single-select" ||
    draft.contentType === "multi-select";

  const manualChip: ManualChipOption = {
    active: draft.tool === "manual-input",
    icon: KeyboardIcon,
    label: t("workspaces.properties.chipManual"),
    onClick: () => onChange({ tool: "manual-input" }),
  };

  return (
    <div className={COMPOSER_CARD_CLASS}>
      <div className="flex items-center gap-2">
        <Input
          autoComplete="off"
          autoFocus
          className="text-foreground placeholder:text-foreground-placeholder w-full px-0 text-[15px] font-semibold tracking-tight"
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder={
            isWorkspace
              ? t("workspaces.properties.newColumnName")
              : t("caseLaw.research.questionPlaceholder")
          }
          unstyled
          value={draft.name}
        />
        {!isWorkspace && (
          // A question column has no prompt beside its wording, so the
          // suggestion works on the wording itself and the control sits with
          // it rather than inside a prompt editor there is none of.
          <AiRewriteControl
            className="text-muted-foreground hover:text-foreground shrink-0"
            disabled={suggestDisabled}
            isPending={suggestPrompt.isPending}
            label={t("workspaces.properties.suggestWithAI")}
            onRewrite={handleAutoPrompt}
          />
        )}
        {canRemove && (
          <Button
            aria-label={t("common.remove")}
            className="text-foreground-placeholder hover:text-foreground ms-auto -me-1 size-6 shrink-0"
            onClick={onRemove}
            size="icon"
            type="button"
            variant="ghost"
          >
            <XIcon className="size-3.5" />
          </Button>
        )}
      </div>

      {isAi && (
        <>
          <ReadingFromRow
            {...(dependencyCount < PROPERTY_DEPENDENCIES_PER_PROPERTY_MAX
              ? {
                  addFile: (id: string) =>
                    onChange({ fileIds: [...draft.fileIds, id] }),
                  availableFiles,
                }
              : {})}
            fileChips={selectedFiles}
            onRemoveFile={(id) =>
              onChange({
                fileIds: draft.fileIds.filter((f) => f !== id),
                mentions: draft.mentions.filter((m) => m !== id),
              })
            }
          />
          {dependencyCount > PROPERTY_DEPENDENCIES_PER_PROPERTY_MAX && (
            <p className="text-destructive text-xs" role="alert">
              {t("workspaces.properties.dependencyLimit", {
                max: format.number(PROPERTY_DEPENDENCIES_PER_PROPERTY_MAX),
              })}
            </p>
          )}

          <PropertyPromptInput
            aiEditAction={{
              disabled: autoPromptDisabled,
              isPending: suggestPrompt.isPending,
              label: t("workspaces.properties.suggestWithAI"),
              onClick: handleAutoPrompt,
            }}
            autoPopulateOnEmpty={false}
            field={promptField}
            onEditorReady={handleEditorReady}
            onMentionsChange={handleMentions}
            placeholder={t("workspaces.properties.extractionPlaceholder")}
            propertyId=""
            propertyName={draft.name}
            variant="minimal"
            workspaceId={workspaceId}
          />
        </>
      )}

      {needsOptions && (
        <InlineOptionEditor
          fallback={draft.fallback}
          {...(isWorkspace
            ? {
                onFallbackChange: (next: string | null) =>
                  onChange({ fallback: next }),
              }
            : {})}
          options={draft.options}
          pushOptions={(added) =>
            onChange({ options: [...draft.options, ...added] })
          }
          removeOptionAt={(index) =>
            onChange({
              options: draft.options.filter((_, i) => i !== index),
            })
          }
          replaceOptionAt={(index, option) =>
            onChange({
              options: draft.options.map((o, i) => (i === index ? option : o)),
            })
          }
        />
      )}

      <div
        {...guideAnchor(GUIDE_ANCHORS.tabularReviewAnswerType, draft.id === 0)}
      >
        <TypeChipsRow
          chipDefs={chipDefs}
          contentType={draft.contentType}
          {...(isWorkspace ? { manualChip } : {})}
          onContentTypeChange={(next) =>
            onChange({ contentType: next, tool: "ai-model" })
          }
          showSeparator
          typeChanged={false}
        />
      </div>
    </div>
  );
};
