import { useRef, useState } from "react";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Result } from "better-result";
import { useTranslations } from "use-intl";

import {
  dictationImportLines,
  type DictationTermImport,
  MAX_ORGANIZATION_DICTATION_TERMS,
  readDictationTermImport,
} from "@stll/api-contract/dictation-vocabulary";
import { Button } from "@stll/ui/button";
import { openFilePicker } from "@stll/ui/file-picker";
import { FileTextIcon } from "@stll/ui/icons";
import {
  Sheet,
  SheetFooter,
  SheetHeader,
  SheetPanel,
  SheetPopup,
  SheetTitle,
} from "@stll/ui/sheet";
import { Textarea } from "@stll/ui/textarea";
import { stellaToast } from "@stll/ui/toast";

import { detached } from "@/lib/detached";
import { notifyUserError } from "@/lib/errors/user-toast";
import { resourceMutation } from "@/lib/workspace-realtime";
import {
  addDictationTerms,
  checkDictationTerms,
} from "@/routes/_protected.settings/organization/-queries/dictation-vocabulary";

type DictationImportSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/**
 * Adds many words at once: pasted one per line, or read from a .txt or
 * .csv file. The words are reviewed first (how many are new, already
 * listed, repeated or refused) and added only on confirmation.
 */
export const DictationImportSheet = (props: DictationImportSheetProps) => (
  <Sheet onOpenChange={props.onOpenChange} open={props.open}>
    {props.open ? <DictationImportSheetBody {...props} /> : null}
  </Sheet>
);

type Review = DictationTermImport & { listed: number; total: number };

const DictationImportSheetBody = ({
  onOpenChange,
}: DictationImportSheetProps) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const [text, setText] = useState("");
  const [review, setReview] = useState<Review | null>(null);
  const [checking, setChecking] = useState(false);
  // Every edit moves the revision; a review that finishes for an older text
  // is dropped, so confirming adds the words shown.
  const revision = useRef(0);
  // The review answers for the text it read; editing waits for it.
  const check = async () => {
    const checkedRevision = revision.current;
    setChecking(true);
    const read = readDictationTermImport(dictationImportLines(text, "lines"));
    const checked =
      read.terms.length === 0
        ? Result.ok({ listed: 0, total: 0 })
        : await Result.tryPromise(
            async () =>
              await checkDictationTerms(read.terms.map(({ term }) => term)),
          );
    setChecking(false);
    if (revision.current !== checkedRevision) {
      return;
    }
    if (checked.isErr()) {
      notifyUserError(checked.error, t("errors.actionFailed"));
      return;
    }
    setReview({ ...read, ...checked.value });
  };
  const fresh = review === null ? 0 : review.terms.length - review.listed;
  const room =
    review === null ? 0 : MAX_ORGANIZATION_DICTATION_TERMS - review.total;
  // Built outside useMutation so its types are inferred from the write.
  const addTerms = resourceMutation({
    mutation: "addDictationVocabulary",
    queryClient,
    scope: { type: "organization" },
    mutationFn: addDictationTerms,
  });
  // A batch that failed leaves the others' words added; the write still
  // settles, so the list refreshes, and the review is read again before a
  // retry.
  const add = useMutation({
    mutationFn: addTerms,
    onSuccess: ({ added, failure }) => {
      if (added > 0 || failure === null) {
        stellaToast.add({
          title: t("settings.organization.dictation.importedToast", {
            count: added,
          }),
          type: "success",
        });
      }
      if (failure !== null) {
        notifyUserError(failure.error, t("errors.actionFailed"));
        setReview(null);
        return;
      }
      onOpenChange(false);
    },
    onError: (error) => {
      notifyUserError(error, t("errors.actionFailed"));
    },
  });
  const edit = (next: string) => {
    revision.current += 1;
    setText(next);
    setReview(null);
  };
  // A CSV shows only its first cells, so what is edited is what is added.
  const readFile = async (file: File) => {
    if (checking) {
      return;
    }
    const content = await file.text();
    edit(
      file.name.toLowerCase().endsWith(".csv")
        ? dictationImportLines(content, "csv").join("\n")
        : content,
    );
  };

  return (
    <SheetPopup side="inline-end">
      <SheetHeader>
        <SheetTitle>{t("settings.organization.dictation.addMany")}</SheetTitle>
      </SheetHeader>
      <SheetPanel>
        <div className="flex flex-col gap-3">
          <p className="text-muted-foreground text-sm">
            {t("settings.organization.dictation.importHint")}
          </p>
          <Textarea
            aria-label={t("settings.organization.dictation.pasteLabel")}
            disabled={checking}
            maxRows={16}
            onChange={(event) => {
              edit(event.target.value);
            }}
            placeholder={t("settings.organization.dictation.pastePlaceholder")}
            rows={8}
            value={text}
          />
          <div>
            <Button
              onClick={() => {
                openFilePicker({
                  accept: ".txt,.csv,text/plain,text/csv",
                  onPick: ([file]) => {
                    detached(
                      readFile(file),
                      "dictation-import-sheet.read-file",
                    );
                  },
                });
              }}
              size="sm"
              variant="outline"
            >
              <FileTextIcon />
              {t("common.chooseFile")}
            </Button>
          </div>
          {review !== null && (
            <ImportReview
              fresh={fresh}
              review={review}
              room={room}
              total={review.total}
            />
          )}
        </div>
      </SheetPanel>
      <SheetFooter>
        <Button
          onClick={() => {
            onOpenChange(false);
          }}
          variant="ghost"
        >
          {t("common.cancel")}
        </Button>
        {review === null ? (
          <Button
            loading={checking}
            onClick={() => {
              detached(check(), "dictation-import-sheet.review");
            }}
          >
            {t("settings.organization.dictation.review")}
          </Button>
        ) : (
          // Offered only when the new words fit; the review says why not.
          fresh > 0 &&
          fresh <= room && (
            <Button
              loading={add.isPending}
              onClick={() => {
                add.mutate(review.terms.map(({ term }) => term));
              }}
            >
              {t("settings.organization.dictation.addCount", { count: fresh })}
            </Button>
          )
        )}
      </SheetFooter>
    </SheetPopup>
  );
};

const ImportReview = ({
  review,
  fresh,
  room,
  total,
}: {
  review: Review;
  fresh: number;
  room: number;
  total: number;
}) => {
  const t = useTranslations();
  const lines = [
    t("settings.organization.dictation.reviewNew", { count: fresh }),
    t("settings.organization.dictation.reviewListed", {
      count: review.listed,
    }),
    t("settings.organization.dictation.reviewRepeated", {
      count: review.repeated,
    }),
    t("settings.organization.dictation.reviewTooLong", {
      count: review.tooLong,
    }),
    t("settings.organization.dictation.reviewInvalid", {
      count: review.invalid,
    }),
  ];
  return (
    <div
      aria-live="polite"
      className="bg-muted/40 flex flex-col gap-1 rounded-md border p-3 text-sm"
    >
      <ul className="flex flex-col gap-0.5">
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      {fresh > room && (
        <p className="text-destructive">
          {t("settings.organization.dictation.reviewOverLimit", {
            total,
            room: Math.max(room, 0),
            max: MAX_ORGANIZATION_DICTATION_TERMS,
          })}
        </p>
      )}
    </div>
  );
};
