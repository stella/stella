import { panic, Result } from "better-result";
import * as v from "valibot";

import {
  BROWSER_DOWNLOAD_FILE_MAX_BYTES,
  BROWSER_DOWNLOAD_FORM_FIELD,
  type BrowserDownloadFiled,
  browserDownloadFiledSchema,
  type BrowserDownloadOrigin,
  localRunBrowserDownloadPath,
} from "@stll/api-contract/browser-downloads";

import { readWorkspaceFile } from "./workspace-file";

/**
 * Files a PDF the member's Chrome downloaded for a run with stella, as the
 * run's own agent token: into the chat's matter as a document, or with the
 * chat when it is in no matter (`apps/api` decides which, from the run's
 * chat, never from this request). Like every step's output of a run on the
 * member's computer, it is stored by stella as a cloud run's would be. The
 * copy in the run's folder stays for the agent's own reading.
 */

/** One upload's request; a large PDF on a slow line needs this long. */
const FILING_TIMEOUT_MS = 120_000;

const LIMIT_MIB = BROWSER_DOWNLOAD_FILE_MAX_BYTES / (1024 * 1024);

/** What became of filing one download, as the agent reads it. */
export type BrowserDownloadFiling =
  | {
      status: "document";
      documentId: string;
      matterId: string;
      name: string;
      /** The matter already held these bytes; this names that document. */
      duplicate: boolean;
    }
  | { status: "chat_file"; fileId: string; name: string }
  | { status: "not_filed"; message: string };

/** Files one saved download; see the module's comment. */
export type FileBrowserDownload = (download: {
  /** `/`-separated, relative to the run's folder. */
  path: string;
  origin: BrowserDownloadOrigin;
}) => Promise<BrowserDownloadFiling>;

const notFiled = (message: string): BrowserDownloadFiling => ({
  message: `${message} The file is in your working folder only.`,
  status: "not_filed",
});

/**
 * The filer of a run in Plan mode, which changes nothing outside its own
 * folder: a download stays there and nothing is filed with stella.
 */
export const keepLocalInPlan: FileBrowserDownload = async () =>
  await Promise.resolve(
    notFiled("In Plan mode stella files nothing into the matter."),
  );

const filingOf = (filed: BrowserDownloadFiled): BrowserDownloadFiling => {
  switch (filed.type) {
    case "document":
      return {
        documentId: filed.entityId,
        duplicate: filed.duplicate,
        matterId: filed.workspaceId,
        name: filed.name,
        status: "document",
      };
    case "chat_file":
      return { fileId: filed.fileId, name: filed.name, status: "chat_file" };
    default:
      filed satisfies never;
      return panic("Unhandled filed download");
  }
};

const refusalSchema = v.object({ message: v.string() });

type FilingTarget = {
  /** The stella API origin, from the desktop's own configuration. */
  apiOrigin: string;
  runId: string;
  /** The run's current agent token; `null` once the run holds none. */
  token: () => string | null;
  /** Ends the filing with the run. */
  stopped: AbortSignal;
  /** The run's folder, where the saved copy is read from. */
  workspaceDir: string;
};

/** The filer of one run: reads the saved copy and posts it with its origin. */
export const browserDownloadFiler =
  ({
    apiOrigin,
    runId,
    stopped,
    token,
    workspaceDir,
  }: FilingTarget): FileBrowserDownload =>
  async ({ origin, path }) => {
    const bearer = token();
    if (bearer === null) {
      return notFiled("The run can no longer reach stella.");
    }
    const read = await readWorkspaceFile(
      workspaceDir,
      path,
      BROWSER_DOWNLOAD_FILE_MAX_BYTES,
    );
    if (read.type === "refused") {
      return notFiled(
        read.reason === "too_large"
          ? `It is larger than ${String(LIMIT_MIB)} MiB, the most stella files.`
          : "The saved copy could not be read.",
      );
    }
    const body = new FormData();
    const name = path.split("/").at(-1) ?? "download.pdf";
    body.set(
      BROWSER_DOWNLOAD_FORM_FIELD.file,
      new File([new Uint8Array(read.bytes)], name, {
        type: "application/pdf",
      }),
    );
    body.set(BROWSER_DOWNLOAD_FORM_FIELD.sourceUrl, origin.sourceUrl);
    if (origin.pageUrl !== null) {
      body.set(BROWSER_DOWNLOAD_FORM_FIELD.pageUrl, origin.pageUrl);
    }
    body.set(BROWSER_DOWNLOAD_FORM_FIELD.downloadedAt, origin.downloadedAt);
    const response = await Result.tryPromise(
      async () =>
        await fetch(new URL(localRunBrowserDownloadPath(runId), apiOrigin), {
          method: "POST",
          headers: { authorization: `Bearer ${bearer}` },
          body,
          // A redirect would move the token to another URL.
          redirect: "error",
          signal: AbortSignal.any([
            stopped,
            AbortSignal.timeout(FILING_TIMEOUT_MS),
          ]),
        }),
    );
    if (Result.isError(response)) {
      return notFiled("stella could not be reached.");
    }
    const answer = await Result.tryPromise(
      async (): Promise<unknown> => await response.value.json(),
    );
    if (!response.value.ok) {
      const refusal = Result.isOk(answer)
        ? v.safeParse(refusalSchema, answer.value)
        : null;
      return notFiled(
        refusal?.success === true
          ? `stella did not file it: ${refusal.output.message.replace(/\.$/u, "")}.`
          : `stella did not file it (${String(response.value.status)}).`,
      );
    }
    const filed = Result.isOk(answer)
      ? v.safeParse(browserDownloadFiledSchema, answer.value)
      : null;
    return filed?.success === true
      ? filingOf(filed.output)
      : notFiled("stella's answer named no document.");
  };
