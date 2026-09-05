import { buildCommand } from "@stricli/core";
import type { Command } from "@stricli/core";
import { Result } from "better-result";

import type { Context } from "../context.js";
import { formatCapabilityCommand } from "../generate-capability-tree.js";
import { EXIT_CODES } from "../mcp-constants.js";
import { buildCommonFlags, type CommonFlagValues } from "../output-flags.js";
import { buildRenderPlan, renderResult, terminalWidth } from "../output.js";
import {
  mapClientErrorExit,
  readOutputFormat,
  renderToolError,
  reservedFlagUsageError,
  scopeGranted,
  setExit,
  writersFor,
  requestIdLine,
  readRequestReceipt,
} from "../run-leaf-command.js";
import {
  createUploadDocumentDependencies,
  type UploadFailure,
  uploadDocument,
} from "../upload-document.js";

const parseString = (input: string): string => input;

/**
 * The exact shape stricli's `ParsedFlagParameter` wants for a required vs. an
 * optional string flag (`kind: "parsed"` literal, `optional` literal or
 * absent). Written out by hand — rather than left for `buildCommand` to
 * infer through `as const` — because `uploadSpecificFlags` below is exported,
 * and an exported const's initializer must carry an explicit type under
 * `isolatedDeclarations`; `optionalStringFlag`'s call sites feed straight
 * into it, so its return type needs the same treatment.
 */
type RequiredStringFlagSpec = {
  readonly brief: string;
  readonly kind: "parsed";
  readonly parse: (input: string) => string;
};

type OptionalStringFlagSpec = {
  readonly brief: string;
  readonly kind: "parsed";
  readonly optional: true;
  readonly parse: (input: string) => string;
};

const optionalStringFlag = (brief: string): OptionalStringFlagSpec => ({
  brief,
  kind: "parsed",
  optional: true,
  parse: parseString,
});

type UploadFlags = CommonFlagValues & {
  readonly entityId: string | undefined;
  readonly file: string;
  readonly mimeType: string | undefined;
  readonly name: string | undefined;
  readonly parentId: string | undefined;
  readonly propertyId: string | undefined;
  readonly matterId: string;
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

/**
 * This command's own flags (the shared `buildCommonFlags()` ones excluded),
 * as one plain object literal `buildCommand` registers directly. Exported so
 * the generated skill (`generate-skill.ts`) can state `stella upload`'s real
 * invocation (which flags exist, which are required) from this SAME object
 * instead of hand-typed prose that could silently drift from it. A flag here
 * is required unless it carries `optional: true` (see `optionalStringFlag`).
 */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const uploadSpecificFlags: {
  readonly file: RequiredStringFlagSpec;
  readonly matterId: RequiredStringFlagSpec;
  readonly propertyId: OptionalStringFlagSpec;
  readonly parentId: OptionalStringFlagSpec;
  readonly entityId: OptionalStringFlagSpec;
  readonly name: OptionalStringFlagSpec;
  readonly mimeType: OptionalStringFlagSpec;
} = {
  file: {
    brief: "Local file path to upload",
    kind: "parsed",
    parse: parseString,
  },
  matterId: {
    brief: "Matter id that will own the document",
    kind: "parsed",
    parse: parseString,
  },
  propertyId: optionalStringFlag(
    "File-property id override; by default the unique file property is discovered automatically",
  ),
  parentId: optionalStringFlag("Destination folder entity id"),
  entityId: optionalStringFlag(
    "Existing document entity id; when set, upload the file as its new version",
  ),
  name: optionalStringFlag(
    "Document name override; defaults to the local file name",
  ),
  mimeType: optionalStringFlag(
    "MIME type override; by default it is inferred from the standard extension database",
  ),
};

export const uploadCommand: Command<Context> = buildCommand<
  UploadFlags,
  [],
  Context
>({
  docs: {
    brief: "Upload a local file as a document or new version",
    fullDescription:
      "Reads the local file, computes its SHA-256 checksum, infers its MIME type unless overridden, reserves a presigned upload, PUTs the exact bytes with the signed headers, and finalizes it. Pass --entity-id to add a version to an existing document; omit it to create a document, resolving the matter's file property when --property-id is omitted. A failed PUT is abandoned automatically; a finalize failure prints the upload id for retry.",
  },
  func: async function func(this: Context, flags) {
    const writers = writersFor(this);
    const usageError = reservedFlagUsageError(flags);
    if (usageError !== null) {
      writers.stderr(`${usageError}\n`);
      setExit(this, EXIT_CODES.validation);
      return;
    }
    if (this.serverUrl === undefined || this.token === undefined) {
      writers.stderr(
        "Not signed in. Run 'stella auth login' to authenticate.\n",
      );
      setExit(this, EXIT_CODES.auth);
      return;
    }
    if (
      flags.entityId !== undefined &&
      (flags.parentId !== undefined || flags.propertyId !== undefined)
    ) {
      writers.stderr(
        "--entity-id creates a version and cannot be combined with --parent-id or --property-id.\n",
      );
      setExit(this, EXIT_CODES.validation);
      return;
    }
    const requiredScope =
      flags.entityId === undefined ? "matters_write" : "documents_write";
    if (!scopeGranted({ token: this.token, scope: requiredScope })) {
      writers.stderr(
        `Missing scope stella:${requiredScope}. Re-run 'stella auth login' to grant stella:${requiredScope}.\n`,
      );
      setExit(this, EXIT_CODES.auth);
      return;
    }
    if (
      flags.entityId === undefined &&
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
        mimeType: flags.mimeType,
        name: flags.name,
        workspaceId: flags.matterId,
        ...(flags.entityId === undefined
          ? {
              target: "new_document" as const,
              parentId: flags.parentId,
              propertyId: flags.propertyId,
            }
          : { target: "new_version" as const, entityId: flags.entityId }),
      },
    });
    if (Result.isOk(uploaded)) {
      // The finalize capability wraps its outcome in `{ finalizedResult, meta }`;
      // the outcome alone is the command's result, shaped like every other
      // save (`{ type, entityId, ... }`), and the receipt goes to stderr like
      // any other write's request id.
      const envelope = isRecord(uploaded.value) ? uploaded.value : {};
      const requestId = readRequestReceipt(uploaded.value);
      if (requestId !== undefined) {
        writers.stderr(requestIdLine(requestId, this.process.stderr.isTTY));
      }
      const finalizedResult = envelope["finalizedResult"];
      renderResult({
        width: terminalWidth(this),
        plan: buildRenderPlan({
          payload: isRecord(finalizedResult) ? finalizedResult : uploaded.value,
          itemsKey: undefined,
          windowedText: false,
          singleReadActive: true,
          columns: undefined,
        }),
        format: readOutputFormat(flags, this),
        writers,
        allActive: false,
      });
      return;
    }

    if (uploaded.error.type !== "finalize") {
      renderNestedFailure({ context: this, failure: uploaded.error });
      return;
    }
    renderNestedFailure({ context: this, failure: uploaded.error.failure });
    writers.stderr(
      `hint: retry finalization with '${formatCapabilityCommand("uploads.update")} --matter-id ${flags.matterId} --upload-id ${uploaded.error.uploadId}'\n`,
    );
  },
  parameters: {
    flags: {
      ...buildCommonFlags(),
      ...uploadSpecificFlags,
    },
  },
});
