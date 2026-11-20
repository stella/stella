import { useState } from "react";

import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { panic, Result } from "better-result";
import { useDebounce } from "use-debounce";
import { useTranslations } from "use-intl";

import { readDictationTerm } from "@stll/api-contract/dictation-vocabulary";
import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { Checkbox } from "@stll/ui/checkbox";
import { DestructiveConfirmDialog } from "@stll/ui/destructive-confirm-dialog";
import { Form } from "@stll/ui/form";
import { DownloadIcon, Trash2Icon, UploadIcon } from "@stll/ui/icons";
import { Input } from "@stll/ui/input";
import {
  List,
  ListEmpty,
  ListGroup,
  ListGroupAction,
  ListGroupCount,
  ListGroupHeader,
  ListGroupHeading,
  ListGroupTitle,
  ListItem,
  ListItemActions,
  ListItemContent,
  ListItemTitle,
} from "@stll/ui/list";
import { SearchField } from "@stll/ui/search-field";
import { stellaToast } from "@stll/ui/toast";

import { SettledQueryViewFeedback } from "@/components/query-view-feedback";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { detached } from "@/lib/detached";
import { notifyUserError } from "@/lib/errors/user-toast";
import { queryView } from "@/lib/query-view.logic";
import { downloadFile } from "@/lib/utils";
import { resourceMutation } from "@/lib/workspace-realtime";
import { DictationImportSheet } from "@/routes/_protected.settings/organization/-components/organization/dictation-import-sheet";
import {
  addDictationTerms,
  deleteDictationTerms,
  dictationVocabularyOptions,
  exportDictationTerms,
} from "@/routes/_protected.settings/organization/-queries/dictation-vocabulary";
import type { DictationVocabularyTerm } from "@/routes/_protected.settings/organization/-queries/dictation-vocabulary";

const SEARCH_DEBOUNCE_MS = 250;

/**
 * The organization's dictation words: one list every member's dictation
 * uses. It may hold thousands of words, so it is searched and paged on the
 * server and only the loaded pages are drawn.
 */
export const DictationVocabularyCard = () => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const { activeOrganizationId } = useAuthenticatedUser();
  const [search, setSearch] = useState("");
  const [serverSearch] = useDebounce(search.trim(), SEARCH_DEBOUNCE_MS);
  const [selected, setSelected] = useState<
    ReadonlySet<DictationVocabularyTerm["id"]>
  >(new Set());
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [importing, setImporting] = useState(false);
  const list = useInfiniteQuery(
    dictationVocabularyOptions(activeOrganizationId, serverSearch),
  );
  const firstPage = list.data?.pages.at(0);
  const words =
    list.data === undefined
      ? []
      : list.data.pages.flatMap(({ items }) => items);
  // The words' resource contracts refresh the list after every write. The
  // type arguments are explicit: useMutation's contextual type would
  // otherwise infer the answer as unknown.
  const remove = useMutation({
    mutationFn: resourceMutation<
      "deleteDictationVocabulary",
      { deleted: number },
      readonly DictationVocabularyTerm["id"][]
    >({
      mutation: "deleteDictationVocabulary",
      queryClient,
      scope: { type: "organization" },
      mutationFn: deleteDictationTerms,
    }),
    onSuccess: ({ deleted }) => {
      setSelected(new Set());
      stellaToast.add({
        title: t("settings.organization.dictation.deletedToast", {
          count: deleted,
        }),
        type: "success",
      });
    },
    onError: (error) => {
      notifyUserError(error, t("errors.actionFailed"));
    },
  });
  const [exporting, setExporting] = useState(false);
  const download = async () => {
    setExporting(true);
    const exported = await Result.tryPromise(exportDictationTerms);
    setExporting(false);
    if (exported.isErr()) {
      notifyUserError(exported.error, t("errors.actionFailed"));
      return;
    }
    downloadFile(
      new Blob([exported.value.join("\n")], {
        type: "text/plain;charset=utf-8",
      }),
      t("settings.organization.dictation.exportFileName"),
    );
  };
  const toggle = (id: DictationVocabularyTerm["id"], checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  };
  const total = firstPage?.total ?? 0;
  const max = firstPage?.max;

  return (
    <ListGroup aria-labelledby="dictation-vocabulary-title">
      <ListGroupHeader>
        <ListGroupHeading>
          <ListGroupTitle id="dictation-vocabulary-title">
            {t("settings.organization.dictation.wordsTitle")}
            {max !== undefined && (
              <ListGroupCount
                count={t("settings.organization.dictation.count", {
                  total,
                  max,
                })}
              />
            )}
          </ListGroupTitle>
        </ListGroupHeading>
        <ListGroupAction>
          <Button
            onClick={() => {
              setImporting(true);
            }}
            size="sm"
            variant="outline"
          >
            <UploadIcon />
            {t("settings.organization.dictation.addMany")}
          </Button>
          <Button
            disabled={total === 0}
            loading={exporting}
            onClick={() => {
              detached(download(), "dictation-vocabulary-card.export");
            }}
            size="sm"
            variant="ghost"
          >
            <DownloadIcon />
            {t("settings.organization.dictation.export")}
          </Button>
        </ListGroupAction>
      </ListGroupHeader>
      <AddWordForm full={max !== undefined && total >= max} />
      <div className="flex flex-wrap items-center gap-2">
        <SearchField
          aria-label={t("settings.organization.dictation.searchPlaceholder")}
          clearLabel={t("common.clearSearch")}
          groupClassName="min-w-0 flex-1"
          onValueChange={setSearch}
          placeholder={t("settings.organization.dictation.searchPlaceholder")}
          value={search}
        />
        {selected.size > 0 && (
          <Button
            onClick={() => {
              setConfirmingDelete(true);
            }}
            size="sm"
            variant="destructive-outline"
          >
            <Trash2Icon />
            {t("settings.organization.dictation.deleteSelected", {
              count: selected.size,
            })}
          </Button>
        )}
      </div>
      <List aria-busy={list.isFetching}>
        {words.map((word) => (
          <ListItem key={word.id}>
            <Checkbox
              aria-label={t("settings.organization.dictation.selectWord", {
                word: word.term,
              })}
              checked={selected.has(word.id)}
              onCheckedChange={(checked) => {
                toggle(word.id, checked);
              }}
            />
            <ListItemContent>
              <ListItemTitle>
                <BidiText>{word.term}</BidiText>
              </ListItemTitle>
            </ListItemContent>
            <ListItemActions>
              <Button
                aria-label={t("settings.organization.dictation.deleteWord", {
                  word: word.term,
                })}
                disabled={remove.isPending}
                onClick={() => {
                  remove.mutate([word.id]);
                }}
                size="icon-sm"
                variant="ghost"
              >
                <Trash2Icon />
              </Button>
            </ListItemActions>
          </ListItem>
        ))}
        {list.isSuccess && words.length === 0 && (
          <ListEmpty>
            {serverSearch.length === 0
              ? t("settings.organization.dictation.empty")
              : t("settings.organization.dictation.noMatch", {
                  search: serverSearch,
                })}
          </ListEmpty>
        )}
      </List>
      <SettledQueryViewFeedback view={queryView(list)} />
      {list.hasNextPage && (
        <Button
          className="self-center"
          loading={list.isFetchingNextPage}
          onClick={() => {
            detached(
              list.fetchNextPage(),
              "dictation-vocabulary-card.fetch-next-page",
            );
          }}
          size="sm"
          variant="ghost"
        >
          {t("settings.organization.dictation.showMore", {
            shown: words.length,
            matching: firstPage?.matching ?? words.length,
          })}
        </Button>
      )}
      <DestructiveConfirmDialog
        cancelLabel={t("common.cancel")}
        confirmLabel={t("common.delete")}
        confirmation={String(selected.size)}
        description={t(
          "settings.organization.dictation.deleteSelectedDescription",
        )}
        inputLabel={t("settings.organization.dictation.deleteSelectedInput", {
          number: String(selected.size),
        })}
        loading={remove.isPending}
        onConfirm={() => remove.mutateAsync([...selected])}
        onOpenChange={setConfirmingDelete}
        open={confirmingDelete}
        title={t("settings.organization.dictation.deleteSelectedTitle", {
          count: selected.size,
        })}
      />
      <DictationImportSheet onOpenChange={setImporting} open={importing} />
    </ListGroup>
  );
};

/** One word typed in, checked against the same rules the list keeps. */
const AddWordForm = ({ full }: { full: boolean }) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState("");
  const reading = readDictationTerm(draft);
  const add = useMutation({
    mutationFn: resourceMutation<
      "addDictationVocabulary",
      { added: number },
      string
    >({
      mutation: "addDictationVocabulary",
      queryClient,
      scope: { type: "organization" },
      mutationFn: async (term: string) => await addDictationTerms([term]),
    }),
    onSuccess: ({ added }, term) => {
      setDraft("");
      stellaToast.add({
        title:
          added === 0
            ? t("settings.organization.dictation.alreadyListedToast", {
                word: term,
              })
            : t("settings.organization.dictation.addedToast", { word: term }),
        type: "success",
      });
    },
    onError: (error) => {
      notifyUserError(error, t("errors.actionFailed"));
    },
  });
  const problem = wordProblem(reading.type);

  return (
    <Form
      action={() => {
        if (reading.type === "term") {
          add.mutate(reading.term);
        }
      }}
      density="compact"
    >
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <Input
            aria-describedby={
              problem === null ? undefined : "dictation-word-problem"
            }
            aria-invalid={problem !== null}
            aria-label={t("settings.organization.dictation.addLabel")}
            autoComplete="off"
            disabled={add.isPending || full}
            onChange={(event) => {
              setDraft(event.target.value);
            }}
            placeholder={t("settings.organization.dictation.addLabel")}
            value={draft}
          />
          {problem !== null && (
            <p className="text-destructive text-xs" id="dictation-word-problem">
              {t(problem)}
            </p>
          )}
          {full && (
            <p className="text-muted-foreground text-xs">
              {t("settings.organization.dictation.full")}
            </p>
          )}
        </div>
        <Button
          disabled={reading.type !== "term" || full}
          loading={add.isPending}
          size="sm"
          type="submit"
        >
          {t("common.add")}
        </Button>
      </div>
    </Form>
  );
};

const wordProblem = (reading: ReturnType<typeof readDictationTerm>["type"]) => {
  switch (reading) {
    case "term":
    case "blank":
      return null;
    case "too-long":
      return "settings.organization.dictation.tooLong" as const;
    case "invalid":
      return "settings.organization.dictation.invalid" as const;
    default:
      reading satisfies never;
      return panic("Unknown dictation word reading");
  }
};
