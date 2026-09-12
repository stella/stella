import { useRef, useState } from "react";

import { useInfiniteQuery, useMutation } from "@tanstack/react-query";
import { TaggedError } from "better-result";
import { FileCheckIcon, PlusIcon } from "lucide-react";
import type { Node as ProseMirrorNode } from "prosemirror-model";
import type { EditorView } from "prosemirror-view";
import { useDebouncedCallback } from "use-debounce";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "@stll/ui/dialog";
import { Input } from "@stll/ui/input";
import { stellaToast } from "@stll/ui/toast";

import { openSourceBoundEntityFile } from "@/components/chat/entity-open";
import { useMountEffect } from "@/hooks/use-effect";
import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { detached } from "@/lib/detached";
import { unwrapEden } from "@/lib/errors/api";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { isFileDisplayable } from "@/lib/types";
import { entitiesWindowOptions } from "@/lib/workspaces/queries/entities";

import {
  collectEvidenceReferences,
  createEvidenceField,
  evidenceLabel,
} from "./evidence-reference";
import type { EvidenceReference } from "./evidence-reference";

type EvidenceReferencesProps = {
  workspaceId: string;
  entityId: string;
  view: EditorView | null;
  document: ProseMirrorNode | null;
  editable: boolean;
  onPrepareEditor: () => void;
};

export const EvidenceReferences = ({
  workspaceId,
  entityId,
  view,
  document,
  editable,
  onPrepareEditor,
}: EvidenceReferencesProps) => {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const collected =
    document === null
      ? { references: [], invalidPositions: [] }
      : collectEvidenceReferences(document);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) {
          onPrepareEditor();
        }
        setOpen(nextOpen);
      }}
    >
      <DialogTrigger
        render={
          <Button
            className="min-h-11"
            size="sm"
            variant="ghost"
            tooltip={t("folio.evidenceReferences")}
          >
            <FileCheckIcon />
            <span>{t("folio.evidenceReferences")}</span>
          </Button>
        }
      />
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{t("folio.evidenceReferences")}</DialogTitle>
          {editable && (
            <DialogDescription>{t("folio.chooseEvidence")}</DialogDescription>
          )}
        </DialogHeader>
        <DialogPanel className="flex max-h-[70dvh] flex-col gap-4 overflow-y-auto">
          {collected.invalidPositions.length > 0 && (
            <p role="alert" className="text-destructive text-sm">
              {t("folio.evidenceUnavailable")}
            </p>
          )}
          {collected.references.length > 0 && (
            <ol className="flex flex-col gap-1">
              {collected.references.map(({ reference, number }) => (
                <li
                  key={`${reference.workspaceId}/${reference.entityId}/${reference.entityVersionId}/${reference.fieldId}`}
                >
                  <Button
                    className="h-auto min-h-11 w-full justify-start text-start whitespace-normal"
                    disabled={reference.workspaceId !== workspaceId}
                    onClick={() => {
                      setOpen(false);
                      detached(
                        openSourceBoundEntityFile(reference),
                        "evidence-reference.open-source",
                      );
                    }}
                    variant="ghost"
                  >
                    <bdi>
                      {evidenceLabel(number)}: {reference.title}
                    </bdi>
                  </Button>
                  {reference.workspaceId !== workspaceId && (
                    <p className="text-destructive text-sm">
                      {t("folio.evidenceUnavailable")}
                    </p>
                  )}
                </li>
              ))}
            </ol>
          )}
          {open && editable && view !== null && (
            <EvidenceFilePicker
              entityId={entityId}
              onInserted={() => setOpen(false)}
              view={view}
              workspaceId={workspaceId}
            />
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
};

class EvidenceSourceUnavailableError extends TaggedError(
  "EvidenceSourceUnavailableError",
)<{ message: string }> {}

type EvidenceFilePickerProps = {
  workspaceId: string;
  entityId: string;
  view: EditorView;
  onInserted: () => void;
};

const EvidenceFilePicker = ({
  workspaceId,
  entityId,
  view,
  onInserted,
}: EvidenceFilePickerProps) => {
  const t = useTranslations();
  const [search, setSearch] = useState("");
  const controller = useRef<AbortController | null>(null);
  useMountEffect(() => {
    const activeController = new AbortController();
    controller.current = activeController;
    return () => activeController.abort();
  });
  const updateSearch = useDebouncedCallback(setSearch, 250);
  const query = useInfiniteQuery(
    entitiesWindowOptions({
      workspaceId,
      filters: [],
      sorts: [],
      search,
      limit: 25,
      excludedKinds: ["folder"],
    }),
  );
  const files =
    query.data?.pages.flatMap((page) =>
      page.entities.flatMap((entity) => {
        if (entity.entityId === entityId) {
          return [];
        }
        return Object.values(entity.fields).flatMap((field) => {
          if (
            field?.content.type !== "file" ||
            !isFileDisplayable(field.content)
          ) {
            return [];
          }
          return [
            {
              entityId: entity.entityId,
              fieldId: field.id,
              title: field.content.fileName,
            },
          ];
        });
      }),
    ) ?? [];
  const insert = useMutation({
    mutationFn: async ({
      entityId: sourceEntityId,
      fieldId,
    }: {
      entityId: string;
      fieldId: string;
    }): Promise<EvidenceReference> => {
      const data = unwrapEden(
        await api
          .entities({ workspaceId })
          .entity({ entityId: sourceEntityId })
          .field({ fieldId })
          .file.get({
            fetch: {
              signal: controller.current?.signal ?? AbortSignal.abort(),
            },
          }),
      );
      if (data.file === null || !isFileDisplayable(data.file)) {
        throw new EvidenceSourceUnavailableError({
          message: "The selected evidence source is unavailable",
        });
      }
      return {
        profile: "cs-evidence",
        workspaceId,
        entityId: sourceEntityId,
        entityVersionId: data.entityVersionId,
        fieldId,
        title: data.file.fileName,
      };
    },
    onSuccess(reference) {
      if (
        controller.current?.signal.aborted !== false ||
        view.isDestroyed ||
        !view.editable
      ) {
        return;
      }
      view.dispatch(
        view.state.tr
          .replaceSelectionWith(
            createEvidenceField(view.state.schema, reference),
            false,
          )
          .scrollIntoView(),
      );
      onInserted();
      view.focus();
    },
    onError(error) {
      if (controller.current?.signal.aborted !== false) {
        return;
      }
      getAnalytics().captureError(error);
      stellaToast.add({
        title: userErrorFromThrown(error, t("folio.evidenceUnavailable")),
        type: "error",
      });
    },
  });

  return (
    <div className="flex flex-col gap-2">
      <Input
        aria-label={t("common.search")}
        placeholder={t("common.search")}
        onChange={(event) => updateSearch(event.target.value)}
      />
      {query.isPending && (
        <p role="status" className="text-muted-foreground text-sm">
          {t("common.loading")}
        </p>
      )}
      {query.isError && (
        <div role="alert">
          <p>{t("errors.actionFailed")}</p>
          <Button
            onClick={() => {
              detached(query.refetch(), "evidence-reference.retry");
            }}
            variant="ghost"
          >
            {t("common.retry")}
          </Button>
        </div>
      )}
      <ul className="flex flex-col gap-1">
        {files.map((file) => (
          <li key={file.fieldId}>
            <Button
              className="h-auto min-h-11 w-full justify-start text-start whitespace-normal"
              disabled={insert.isPending}
              onClick={() => insert.mutate(file)}
              tooltip={t("folio.insertEvidence")}
              variant="ghost"
            >
              <PlusIcon />
              <bdi>{file.title}</bdi>
            </Button>
          </li>
        ))}
      </ul>
      {!query.isPending && !query.isError && files.length === 0 && (
        <p className="text-muted-foreground text-sm">{t("common.noResults")}</p>
      )}
      {query.hasNextPage && (
        <Button
          disabled={query.isFetchingNextPage}
          onClick={() => {
            detached(query.fetchNextPage(), "evidence-reference.load-more");
          }}
          variant="ghost"
        >
          {t("common.loadMore")}
        </Button>
      )}
    </div>
  );
};
