import { buildCommand } from "@stricli/core";
import type { Command } from "@stricli/core";
import { Result } from "better-result";

import type { Context } from "../context.js";
import { EXIT_CODES } from "../mcp-constants.js";
import {
  mapClientErrorExit,
  renderToolError,
  scopeGranted,
  setExit,
  writersFor,
} from "../run-leaf-command.js";
import {
  createUploadDocumentDependencies,
  type UploadFailure,
  uploadDocument,
} from "../upload-document.js";

const parseString = (input: string): string => input;

const optionalStringFlag = (brief: string) =>
  ({ brief, kind: "parsed", optional: true, parse: parseString }) as const;

type UploadFlags = {
  readonly file: string;
  readonly mimeType: string | undefined;
  readonly name: string | undefined;
  readonly parentId: string | undefined;
  readonly propertyId: string | undefined;
  readonly workspace: string;
};

const renderNestedFailure = ({
  context,
  failure,
}: {
  context: Context;
  failure: Exclude<UploadFailure, { type: "finalize" }>;
}): void => {
  const writers = writersFor(context);
  if (failure.type === "client") {
    writers.stderr(`${failure.error.message}\n`);
    setExit(context, mapClientErrorExit(failure.error));
    return;
  }
  if (failure.type === "tool") {
    renderToolError({ context, result: failure.result, writers });
    return;
  }
  writers.stderr(`${failure.message}\n`);
  if (
    (failure.type === "put" || failure.type === "server-response") &&
    failure.cleanupWarning !== undefined
  ) {
    writers.stderr(`warning: ${failure.cleanupWarning}\n`);
  }
  setExit(
    context,
    failure.type === "local" ? EXIT_CODES.validation : EXIT_CODES.server,
  );
};

export const uploadCommand: Command<Context> = buildCommand<
  UploadFlags,
  [],
  Context
>({
  docs: {
    brief: "Upload a local file as a document in one command",
    fullDescription:
      "Reads the local file, computes its SHA-256 checksum, resolves the matter's file property when --property-id is omitted, reserves a presigned upload, PUTs the exact bytes with the signed headers, and finalizes the document. A failed PUT is abandoned automatically; a finalize failure prints the upload id so finalization can be retried without uploading the bytes again.",
  },
  func: async function func(this: Context, flags) {
    const writers = writersFor(this);
    if (this.serverUrl === undefined || this.token === undefined) {
      writers.stderr(
        "Not signed in. Run 'stella auth login' to authenticate.\n",
      );
      setExit(this, EXIT_CODES.auth);
      return;
    }
    if (!scopeGranted({ token: this.token, scope: "matters_write" })) {
      writers.stderr(
        "Missing scope stella:matters_write. Re-run 'stella auth login' to grant stella:matters_write.\n",
      );
      setExit(this, EXIT_CODES.auth);
      return;
    }
    if (
      flags.propertyId === undefined &&
      !scopeGranted({ token: this.token, scope: "read" })
    ) {
      writers.stderr(
        "Automatic file-property resolution needs scope stella:read; grant it or pass --property-id explicitly.\n",
      );
      setExit(this, EXIT_CODES.auth);
      return;
    }

    const uploaded = await uploadDocument({
      dependencies: createUploadDocumentDependencies({
        serverUrl: this.serverUrl,
        token: this.token,
      }),
      input: {
        filePath: flags.file,
        mimeType: flags.mimeType ?? "application/octet-stream",
        name: flags.name,
        parentId: flags.parentId,
        propertyId: flags.propertyId,
        workspaceId: flags.workspace,
      },
    });
    if (Result.isOk(uploaded)) {
      writers.stdout(`${JSON.stringify(uploaded.value, null, 2)}\n`);
      return;
    }

    if (uploaded.error.type !== "finalize") {
      renderNestedFailure({ context: this, failure: uploaded.error });
      return;
    }
    renderNestedFailure({ context: this, failure: uploaded.error.failure });
    writers.stderr(
      `hint: retry finalization with 'stella uploads update --workspace-id ${flags.workspace} --upload-id ${uploaded.error.uploadId}'\n`,
    );
  },
  parameters: {
    flags: {
      file: {
        brief: "Local file path to upload",
        kind: "parsed",
        parse: parseString,
      },
      workspace: {
        brief: "Matter/workspace id that will own the document",
        kind: "parsed",
        parse: parseString,
      },
      propertyId: optionalStringFlag(
        "File-property id override; by default the unique file property is discovered automatically",
      ),
      parentId: optionalStringFlag("Destination folder entity id"),
      name: optionalStringFlag(
        "Document name override; defaults to the local file name",
      ),
      mimeType: optionalStringFlag(
        "MIME type override; defaults to application/octet-stream and the server normalizes known extensions",
      ),
    },
  },
});
