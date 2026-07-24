import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  CAPABILITY_MANIFEST,
  type NativeCallerDetection,
  type NativeTextReplacement,
  type PreparedNativePipeline,
} from "@stll/anonymize";
import { preloadNativeBinding } from "@stll/anonymize/native-runtime";
import {
  AnonymizeSurfaceError,
  classifyToEnvelope,
  type AnonymizeErrorCode,
  type AnonymizeErrorEnvelope,
} from "@stll/anonymize/agent-surface";
import {
  FEEDBACK_KINDS,
  MAX_FEEDBACK_BODY_CHARS,
  MAX_FEEDBACK_TITLE_CHARS,
  buildFeedbackSubmission,
} from "@stll/anonymize/feedback";
import {
  DOCX_ARCHIVE_MAX_BYTES,
  DOCX_COVERAGE_MODES,
  anonymizeDocx,
  extractDocxText,
  restoreDocxText,
  type DocxAnonymizationSession,
  type DocxRestorationSession,
} from "@stll/anonymize-docx";
import {
  PDF_DOCUMENT_MAX_BYTES,
  anonymizePdfRaster,
  renderPdfWithPopplerTesseract,
} from "@stll/anonymize-pdf";
import * as nativeNode from "@stll/anonymize/native-node";
import {
  constants as fsConstants,
  link,
  lstat,
  open,
  realpath,
  stat,
  unlink,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  dirname,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import * as z from "zod/v4";

import pkg from "../package.json" with { type: "json" };

import { DurableSessionStore } from "./durable-sessions";

const TEXT_MAX_BYTES = 64 * 1024 * 1024;
const EXTERNAL_DETECTION_BATCH_MAX_BYTES = 16 * 1024 * 1024;
const EXTERNAL_DETECTION_BATCH_VERSION = 1 as const;
const PATH_MAX_CHARACTERS = 32_768;
const SESSION_MAX_COUNT = 256;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const READ_CHUNK_BYTES = 64 * 1024;

/** Build an agent-surface error carrying a stable code, message, and hint. */
const surfaceError = (
  code: AnonymizeErrorCode,
  message: string,
  hint: string,
  retryable = false,
): AnonymizeSurfaceError =>
  new AnonymizeSurfaceError(code, message, { hint, retryable });

const nodeErrorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? (error as NodeJS.ErrnoException).code
    : undefined;

/**
 * The local PDF provider collapses a missing/failed pdftoppm or tesseract into a
 * `PdfLocalProviderError` with code `executable-failed`; treat it as a missing
 * dependency so agents get an actionable install hint instead of a generic
 * internal error. Duck-typed to avoid importing the provider's internals.
 */
const isPdfToolchainUnavailable = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  (error as { name?: unknown }).name === "PdfLocalProviderError" &&
  (error as { code?: unknown }).code === "executable-failed";

/**
 * The docx package refuses under requireFull coverage with a
 * `DocxAnonymizationError` (code `incomplete-coverage`). Map it to a
 * validation_error so the agent gets the actionable allowPartialCoverage hint
 * instead of a generic internal_error; pass anything else through unchanged.
 * Duck-typed to avoid importing the docx error class.
 */
const mapDocxCoverageError = (error: unknown): unknown => {
  if (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "DocxAnonymizationError" &&
    (error as { code?: unknown }).code === "incomplete-coverage"
  ) {
    // Preserve the docx package's specific (content-free) coverage message; add
    // the stable code and the actionable hint.
    return new AnonymizeSurfaceError(
      "validation_error",
      (error as Error).message,
      {
        hint: "Re-run with allowPartialCoverage: true to accept partial coverage.",
        cause: error,
      },
    );
  }
  return error;
};

const observedAtEpochSeconds = (): number => {
  const seconds = Math.floor(Date.now() / 1000);
  if (seconds < 0 || seconds > 0xff_ff_ff_ff) {
    throw new Error("The current time is outside the supported session range");
  }
  return seconds;
};

export const MCP_SESSION_MODES = {
  durableEncrypted: "durable-encrypted",
  memory: "memory",
} as const;

export type McpSessionMode =
  (typeof MCP_SESSION_MODES)[keyof typeof MCP_SESSION_MODES];

export type AuditSafeResult = {
  operation: "anonymize" | "inspect" | "restore";
  format: "docx" | "pdf" | "text";
  outputCreated: boolean;
  sessionId?: string;
  entityCount?: number;
  blockCount?: number;
  rewrittenBlockCount?: number;
  restoredPlaceholderCount?: number;
  coverageStatus?: "full" | "partial";
  externalDetectionBatchStatus?: "accepted";
  externalDetectionCount?: number;
  retainedExternalDetectionCount?: number;
  pageCount?: number;
  mappedRegionCount?: number;
  structurePixelRewriteVerified?: true;
  piiCleanGuaranteed?: false;
};

const EXTERNAL_DETECTION_FAILURES = {
  batchRejected: {
    code: "EXTERNAL_DETECTION_BATCH_REJECTED",
    message: "The external detection batch was rejected.",
  },
  documentRejected: {
    code: "EXTERNAL_DETECTION_DOCUMENT_REJECTED",
    message: "The external detection document was rejected.",
  },
  inputRejected: {
    code: "EXTERNAL_DETECTION_INPUT_REJECTED",
    message: "The external detection request paths were rejected.",
  },
  operationFailed: {
    code: "EXTERNAL_DETECTION_OPERATION_FAILED",
    message: "The external detection operation failed safely.",
  },
  sessionRejected: {
    code: "EXTERNAL_DETECTION_SESSION_REJECTED",
    message: "The external detection session was rejected.",
  },
} as const;

type ExternalDetectionFailure =
  (typeof EXTERNAL_DETECTION_FAILURES)[keyof typeof EXTERNAL_DETECTION_FAILURES];

class ExternalDetectionAuditError extends Error {
  readonly code: ExternalDetectionFailure["code"];

  constructor(failure: ExternalDetectionFailure) {
    super(failure.message);
    this.name = "ExternalDetectionAuditError";
    this.code = failure.code;
  }
}

const externalDetectionFailure = (
  error: unknown,
  failure: ExternalDetectionFailure,
): ExternalDetectionAuditError =>
  error instanceof ExternalDetectionAuditError
    ? error
    : new ExternalDetectionAuditError(failure);

const externalDetectionStep = async <Result>(
  failure: ExternalDetectionFailure,
  operation: () => Result | Promise<Result>,
): Promise<Result> => {
  try {
    return await operation();
  } catch (error) {
    throw externalDetectionFailure(error, failure);
  }
};

export type LocalAnonymizeServiceFaults = {
  beforeOutputPublish?: () => void | Promise<void>;
};

const inside = (root: string, target: string): boolean => {
  const path = relative(root, target);
  return (
    path === "" ||
    (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  );
};

type ReadInputOptions = {
  path: string;
  extension: ".docx" | ".json" | ".pdf" | ".txt";
  maximumBytes: number;
  label: "DOCX" | "External detection batch" | "PDF" | "Text";
};

type ScopedInput = {
  bytes: Uint8Array;
  path: string;
};

type ReadableFileHandle = Pick<Awaited<ReturnType<typeof open>>, "read">;

const readHandleBounded = async (
  handle: ReadableFileHandle,
  maximumBytes: number,
  label: "DOCX" | "External detection batch" | "PDF" | "Text",
): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const chunk = Buffer.allocUnsafe(
      Math.min(READ_CHUNK_BYTES, maximumBytes - total + 1),
    );
    const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
    if (bytesRead === 0) {
      return Buffer.concat(chunks, total);
    }
    total += bytesRead;
    if (total > maximumBytes) {
      throw surfaceError(
        "validation_error",
        `${label} inputs must not exceed ${maximumBytes} bytes`,
        "Split or shrink the input below the size limit and retry.",
      );
    }
    chunks.push(chunk.subarray(0, bytesRead));
  }
};

type DirectoryIdentity = {
  dev: number;
  ino: number;
  path: string;
};

type FileIdentity = Pick<DirectoryIdentity, "dev" | "ino">;

class ScopedOutput {
  readonly parent: DirectoryIdentity;
  readonly path: string;

  constructor(path: string, parent: DirectoryIdentity) {
    this.path = path;
    this.parent = parent;
  }

  async write(bytes: Uint8Array | string): Promise<void> {
    await safeWrite(this, bytes);
  }
}

export class PathScope {
  readonly #roots: readonly string[];

  private constructor(roots: readonly string[]) {
    this.#roots = roots;
  }

  static async create(roots: readonly string[]): Promise<PathScope> {
    if (roots.length === 0) {
      throw new Error("At least one --root directory is required");
    }
    const canonical = await Promise.all(
      roots.map(async (root) => {
        if (!isAbsolute(root)) {
          throw new Error("MCP roots must be absolute paths");
        }
        const path = await realpath(root);
        const metadata = await stat(path);
        if (!metadata.isDirectory()) {
          throw new Error("Every MCP root must be a directory");
        }
        return path;
      }),
    );
    return new PathScope([...new Set(canonical)]);
  }

  async readInput({
    path,
    extension,
    maximumBytes,
    label,
  }: ReadInputOptions): Promise<ScopedInput> {
    if (!isAbsolute(path)) {
      throw surfaceError(
        "validation_error",
        `Input must be an absolute ${extension} path`,
        "Pass an absolute path to an existing file inside a configured --root.",
      );
    }
    if (extname(path).toLowerCase() !== extension) {
      throw surfaceError(
        "unsupported_format",
        `Input must be an absolute ${extension} path`,
        `Provide a file with the ${extension} extension.`,
      );
    }
    const initiallyCanonical = await this.canonicalInput(path);
    if (!this.#roots.some((root) => inside(root, initiallyCanonical))) {
      throw surfaceError(
        "path_not_allowed",
        "Input is outside the configured roots",
        "Move the input under a configured --root, or add its directory with --root.",
      );
    }
    const initiallyRequestedMetadata = await lstat(path);
    if (!initiallyRequestedMetadata.isFile()) {
      throw surfaceError(
        "validation_error",
        "Input must be a regular file",
        "Point at a regular file, not a directory, symlink, or special file.",
      );
    }
    const handle = await open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
    try {
      const openedMetadata = await handle.stat();
      if (!openedMetadata.isFile()) {
        throw surfaceError(
          "validation_error",
          "Input must be a regular file",
          "Point at a regular file, not a directory, symlink, or special file.",
        );
      }
      const canonical = await realpath(path);
      if (!this.#roots.some((root) => inside(root, canonical))) {
        throw surfaceError(
          "path_not_allowed",
          "Input is outside the configured roots",
          "Move the input under a configured --root, or add its directory with --root.",
        );
      }
      const currentMetadata = await stat(canonical);
      if (
        currentMetadata.dev !== openedMetadata.dev ||
        currentMetadata.ino !== openedMetadata.ino
      ) {
        throw new Error("Input changed while it was being validated");
      }
      if (openedMetadata.size > maximumBytes) {
        throw surfaceError(
          "validation_error",
          `${label} inputs must not exceed ${maximumBytes} bytes`,
          "Split or shrink the input below the size limit and retry.",
        );
      }
      const bytes = await readHandleBounded(handle, maximumBytes, label);
      return { bytes, path: canonical };
    } finally {
      await handle.close();
    }
  }

  /**
   * Canonicalize an input path, mapping a missing path to a `not_found` surface
   * error instead of a raw fs `ENOENT` so agents get a stable code.
   */
  private async canonicalInput(path: string): Promise<string> {
    try {
      return await realpath(path);
    } catch (error) {
      if (nodeErrorCode(error) === "ENOENT") {
        throw surfaceError(
          "not_found",
          "Input path does not exist",
          "Create the file first, or pass an existing path inside a configured --root.",
        );
      }
      throw error;
    }
  }

  async output(
    path: string,
    extension: ".docx" | ".pdf" | ".txt",
  ): Promise<ScopedOutput> {
    if (!isAbsolute(path)) {
      throw surfaceError(
        "validation_error",
        `Output must be an absolute ${extension} path`,
        "Pass an absolute output path inside a configured --root.",
      );
    }
    if (extname(path).toLowerCase() !== extension) {
      throw surfaceError(
        "unsupported_format",
        `Output must be an absolute ${extension} path`,
        `Name the output with the ${extension} extension.`,
      );
    }
    const normalized = resolve(path);
    let parent: string;
    try {
      parent = await realpath(dirname(normalized));
    } catch (error) {
      if (nodeErrorCode(error) === "ENOENT") {
        throw surfaceError(
          "not_found",
          "Output directory does not exist",
          "Create the output directory first, inside a configured --root.",
        );
      }
      throw error;
    }
    if (!this.#roots.some((root) => inside(root, parent))) {
      throw surfaceError(
        "path_not_allowed",
        "Output is outside the configured roots",
        "Choose an output directory under a configured --root.",
      );
    }
    const parentMetadata = await stat(parent);
    try {
      await lstat(normalized);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return new ScopedOutput(normalized, {
          dev: parentMetadata.dev,
          ino: parentMetadata.ino,
          path: parent,
        });
      }
      throw new Error("Output availability could not be verified", {
        cause: error,
      });
    }
    throw surfaceError(
      "output_exists",
      "Output already exists; overwriting is not supported",
      "Pick a new output path; anonymize never overwrites an existing file.",
    );
  }
}

type SessionEntry = {
  language: string | undefined;
  session: RedactionSession;
  restoreSession: (plaintextJson: string) => RedactionSession;
  status: "busy" | "initializing" | "ready";
};

type SessionLease = {
  entry: SessionEntry;
  sessionId: string;
  rollback:
    | { type: "delete" }
    | { type: "release" }
    | { type: "restore"; checkpoint: string };
};

type RedactionSession = DocxAnonymizationSession &
  DocxRestorationSession & {
    redact_text(text: string): {
      redaction: { redactedText: string; entityCount: number };
    };
    restoreText(text: string): string;
    toPlaintextJson(): string;
    toEncryptedArchiveAt(
      key: Uint8Array,
      observedAtEpochSeconds: number,
    ): Uint8Array;
  };

type NativeNodeSurface = {
  convert_external_detection_batch: (
    document: Uint8Array,
    batch: string,
  ) => NativeCallerDetection[];
  getDefaultNativePipeline: (options: { language?: string }) => {
    createRedactionSession: (sessionId: string) => RedactionSession;
    restoreRedactionSession: (plaintextJson: string) => RedactionSession;
    restoreEncryptedRedactionSession: (options: {
      archive: Uint8Array;
      expectedSessionId: string;
      key: Uint8Array;
      observedAtEpochSeconds: number;
    }) => RedactionSession;
  } & Pick<
    PreparedNativePipeline,
    "redactText" | "redactTextWithCallerDetections"
  >;
  native_package_version: () => string;
};

const nativeNodeSurface = nativeNode as unknown as NativeNodeSurface; // SAFETY: These native-node runtime exports are public, but their generated declarations are minified during workspace builds.

const assertOutputParent = async ({
  parent,
  path,
}: ScopedOutput): Promise<void> => {
  const canonical = await realpath(dirname(path));
  const metadata = await stat(canonical);
  if (
    canonical !== parent.path ||
    metadata.dev !== parent.dev ||
    metadata.ino !== parent.ino
  ) {
    throw new Error("Output directory changed while it was being used");
  }
};

const sameFile = (left: FileIdentity, right: FileIdentity): boolean =>
  left.dev === right.dev && left.ino === right.ino;

const safeWrite = async (
  output: ScopedOutput,
  bytes: Uint8Array | string,
): Promise<void> => {
  await assertOutputParent(output);
  const temporary = `${output.path}.stella-${randomUUID()}.tmp`;
  let published = false;
  let committed = false;
  let temporaryMetadata: FileIdentity | undefined;
  const handle = await open(
    temporary,
    fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      fsConstants.O_NOFOLLOW,
    0o400,
  );
  try {
    temporaryMetadata = await handle.stat();
    const canonicalTemporary = await realpath(temporary);
    const currentTemporaryMetadata = await lstat(temporary);
    if (
      dirname(canonicalTemporary) !== output.parent.path ||
      !currentTemporaryMetadata.isFile() ||
      !sameFile(temporaryMetadata, currentTemporaryMetadata)
    ) {
      throw new Error("Output staging file changed while it was being used");
    }
    await handle.writeFile(bytes);
    await handle.sync();
    await assertOutputParent(output);
    const stagedMetadata = await lstat(temporary);
    if (
      !stagedMetadata.isFile() ||
      !sameFile(temporaryMetadata, stagedMetadata)
    ) {
      throw new Error("Output staging file changed before publication");
    }
    await link(temporary, output.path);
    published = true;
    const publishedMetadata = await lstat(output.path);
    if (
      !publishedMetadata.isFile() ||
      !sameFile(temporaryMetadata, publishedMetadata)
    ) {
      throw new Error("Published output does not match the staged file");
    }
    await assertOutputParent(output);
    await handle.chmod(0o600);
    await handle.sync();
    committed = true;
  } finally {
    if (!committed) {
      await handle.truncate(0).catch(() => undefined);
      await handle.sync().catch(() => undefined);
      await handle.chmod(0o000).catch(() => undefined);
    }
    await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    if (published && !committed && temporaryMetadata !== undefined) {
      const publishedMetadata = await lstat(output.path).catch(() => undefined);
      if (
        publishedMetadata !== undefined &&
        sameFile(temporaryMetadata, publishedMetadata)
      ) {
        await unlink(output.path).catch(() => undefined);
      }
    }
  }
};

const decodeText = (bytes: Uint8Array): string => {
  return decodeUtf8(bytes, "Text inputs");
};

const decodeUtf8 = (bytes: Uint8Array, label: string): string => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new AnonymizeSurfaceError(
      "validation_error",
      `${label} must contain valid UTF-8`,
      {
        hint: "Provide UTF-8 encoded text; re-encode the file and retry.",
        cause: error,
      },
    );
  }
};

const applyTextReplacements = (
  text: string,
  replacements: readonly NativeTextReplacement[],
): string => {
  const parts: string[] = [];
  let cursor = 0;
  for (const replacement of replacements) {
    if (
      !Number.isSafeInteger(replacement.start) ||
      !Number.isSafeInteger(replacement.end) ||
      replacement.start < cursor ||
      replacement.end <= replacement.start ||
      replacement.end > text.length ||
      !isUtf16Boundary(text, replacement.start) ||
      !isUtf16Boundary(text, replacement.end)
    ) {
      throw new Error(
        "Native caller-detection plan returned invalid replacements",
      );
    }
    parts.push(text.slice(cursor, replacement.start), replacement.replacement);
    cursor = replacement.end;
  }
  parts.push(text.slice(cursor));
  return parts.join("");
};

const isUtf16Boundary = (text: string, offset: number): boolean => {
  if (offset <= 0 || offset >= text.length) {
    return true;
  }
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return !(
    before >= 0xd800 &&
    before <= 0xdbff &&
    after >= 0xdc00 &&
    after <= 0xdfff
  );
};

const assertDifferentPaths = (input: string, output: string): void => {
  if (input === output) {
    throw surfaceError(
      "validation_error",
      "Input and output paths must differ",
      "Choose a distinct output path so the input is never overwritten.",
    );
  }
};

const textInput = z.object({
  inputPath: z.string().min(1).max(PATH_MAX_CHARACTERS),
  outputPath: z.string().min(1).max(PATH_MAX_CHARACTERS),
  sessionId: z.string().regex(SESSION_ID),
  language: z.string().min(2).max(35).optional(),
});

const externalDetectionTextInput = textInput.extend({
  detectionBatchPath: z.string().min(1).max(PATH_MAX_CHARACTERS),
});

const restoreInput = z.object({
  inputPath: z.string().min(1).max(PATH_MAX_CHARACTERS),
  outputPath: z.string().min(1).max(PATH_MAX_CHARACTERS),
  sessionId: z.string().regex(SESSION_ID),
});

const docxRestoreInput = restoreInput.extend({
  allowPartialCoverage: z.boolean().optional().default(false),
});

const docxInput = textInput.extend({
  allowPartialCoverage: z.boolean().optional().default(false),
});

const pdfInput = z.object({
  inputPath: z.string().min(1).max(PATH_MAX_CHARACTERS),
  outputPath: z.string().min(1).max(PATH_MAX_CHARACTERS),
  ocrLanguage: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u),
  detectionLanguage: z.string().min(2).max(35).optional(),
  dpi: z.number().int().min(72).max(600).optional().default(300),
  timeoutMs: z.number().int().min(100).max(300_000).optional().default(120_000),
  fillRgb: z
    .tuple([
      z.number().int().min(0).max(255),
      z.number().int().min(0).max(255),
      z.number().int().min(0).max(255),
    ])
    .optional()
    .default([0, 0, 0]),
});

export type LocalPdfProviderConfiguration = {
  pdftoppmPath?: string | undefined;
  tesseractPath?: string | undefined;
};

export type LocalAnonymizeServiceOptions = {
  durableSessions?: DurableSessionStore | undefined;
  faults?: LocalAnonymizeServiceFaults | undefined;
  pdfProvider?: LocalPdfProviderConfiguration | undefined;
};

export class LocalAnonymizeService {
  #activeOperations = 0;
  #closePromise: Promise<void> | undefined;
  #operationsDrained: (() => void) | undefined;
  readonly #scope: PathScope;
  #pdfOperationTail: Promise<void> = Promise.resolve();
  readonly #sessionInitializations = new Set<string>();
  readonly #sessions = new Map<string, SessionEntry>();
  #state: "closed" | "closing" | "open" = "open";
  readonly #durableSessions: DurableSessionStore | undefined;
  readonly #faults: LocalAnonymizeServiceFaults;
  readonly #pdfProvider: LocalPdfProviderConfiguration;

  constructor(scope: PathScope, options: LocalAnonymizeServiceOptions = {}) {
    if (options instanceof DurableSessionStore) {
      throw new TypeError(
        "LocalAnonymizeService requires { durableSessions } as its second argument",
      );
    }
    const { durableSessions, faults = {}, pdfProvider = {} } = options;
    this.#scope = scope;
    this.#durableSessions = durableSessions;
    this.#faults = faults;
    this.#pdfProvider = pdfProvider;
  }

  get sessionMode(): McpSessionMode {
    return this.#durableSessions === undefined
      ? MCP_SESSION_MODES.memory
      : MCP_SESSION_MODES.durableEncrypted;
  }

  async close(): Promise<void> {
    if (this.#closePromise !== undefined) {
      return this.#closePromise;
    }
    this.#state = "closing";
    this.#closePromise = (async () => {
      if (this.#activeOperations > 0) {
        await new Promise<void>((resolvePromise) => {
          this.#operationsDrained = resolvePromise;
        });
      }
      this.#sessions.clear();
      await this.#durableSessions?.close();
      this.#state = "closed";
    })();
    return this.#closePromise;
  }

  async #runOperation<Result>(
    operation: () => Promise<Result>,
  ): Promise<Result> {
    if (this.#state !== "open") {
      throw new Error("MCP anonymize service is closing or closed");
    }
    this.#activeOperations += 1;
    try {
      // Count the operation before the asynchronous preload so close() cannot
      // pass its drain barrier while this call is waiting for the binding.
      // The preload installs wasm under Bun before any inline native load in
      // the docx or pdf package; it is a no-op on Node.
      await preloadNativeBinding();
      return await operation();
    } finally {
      this.#activeOperations -= 1;
      if (this.#activeOperations === 0) {
        this.#operationsDrained?.();
        this.#operationsDrained = undefined;
      }
    }
  }

  async #session(sessionId: string, language?: string): Promise<SessionLease> {
    if (this.#durableSessions !== undefined && language !== undefined) {
      throw new Error(
        "Durable sessions use the full all-language pipeline; omit language",
      );
    }
    const existing = this.#sessions.get(sessionId);
    if (existing !== undefined) {
      if (language !== undefined && existing.language !== language) {
        throw surfaceError(
          "validation_error",
          "A session cannot change language",
          "Use a new session id for a different language, or drop the language override.",
        );
      }
      if (existing.status === "initializing") {
        throw new Error("The requested session is still initializing");
      }
      if (existing.status === "busy") {
        throw new Error("The requested session is handling another operation");
      }
      const checkpoint = existing.session.toPlaintextJson();
      existing.status = "busy";
      return {
        entry: existing,
        sessionId,
        rollback: { type: "restore", checkpoint },
      };
    }
    if (this.#sessionInitializations.has(sessionId)) {
      throw new Error("The requested session is still initializing");
    }
    this.#sessionInitializations.add(sessionId);
    try {
      if (this.#sessions.size >= SESSION_MAX_COUNT) {
        throw new Error(`MCP sessions must not exceed ${SESSION_MAX_COUNT}`);
      }
      const pipeline = nativeNodeSurface.getDefaultNativePipeline(
        language === undefined ? {} : { language },
      );
      const durableSessions = this.#durableSessions;
      const stored =
        durableSessions === undefined
          ? undefined
          : await durableSessions.load(sessionId);
      let session: RedactionSession;
      if (stored === undefined) {
        session = pipeline.createRedactionSession(sessionId);
      } else {
        if (durableSessions === undefined) {
          throw surfaceError(
            "session_unavailable",
            "Durable session storage is unavailable",
            "Start the server with --session-dir and --key-file to enable restores.",
          );
        }
        try {
          session = durableSessions.restore({
            archive: stored.bytes,
            expectedSessionId: sessionId,
            observedAtEpochSeconds: observedAtEpochSeconds(),
            restorer: pipeline,
          });
        } catch (error) {
          throw new AnonymizeSurfaceError(
            "session_unavailable",
            "The requested durable session is unavailable",
            {
              hint: "Confirm the session id and key file match the archive that created it.",
              cause: error,
            },
          );
        }
      }
      const entry: SessionEntry = {
        language,
        session,
        restoreSession: (plaintextJson) =>
          pipeline.restoreRedactionSession(plaintextJson),
        status: "initializing",
      };
      this.#sessions.set(sessionId, entry);
      return {
        entry,
        sessionId,
        rollback:
          stored === undefined
            ? { type: "delete" }
            : { type: "restore", checkpoint: session.toPlaintextJson() },
      };
    } finally {
      this.#sessionInitializations.delete(sessionId);
    }
  }

  #commitSession({ entry }: SessionLease): void {
    entry.status = "ready";
  }

  async #rollbackSession({
    entry,
    rollback,
    sessionId,
  }: SessionLease): Promise<void> {
    if (this.#sessions.get(sessionId) !== entry) {
      return;
    }
    if (rollback.type === "delete") {
      this.#sessions.delete(sessionId);
      await this.#durableSessions?.delete(sessionId).catch(() => undefined);
      return;
    }
    if (rollback.type === "release") {
      entry.status = "ready";
      return;
    }
    try {
      entry.session = entry.restoreSession(rollback.checkpoint);
      entry.status = "ready";
      await this.#persistSession(sessionId, entry.session);
    } catch {
      this.#sessions.delete(sessionId);
    }
  }

  async #readSession(sessionId: string): Promise<SessionLease> {
    let entry = this.#sessions.get(sessionId);
    if (entry === undefined && this.#durableSessions !== undefined) {
      if (this.#sessionInitializations.has(sessionId)) {
        throw new Error("The requested session is still initializing");
      }
      this.#sessionInitializations.add(sessionId);
      try {
        const pipeline = nativeNodeSurface.getDefaultNativePipeline({});
        const stored = await this.#durableSessions.load(sessionId);
        if (stored !== undefined) {
          try {
            const session = this.#durableSessions.restore({
              archive: stored.bytes,
              expectedSessionId: sessionId,
              observedAtEpochSeconds: observedAtEpochSeconds(),
              restorer: pipeline,
            });
            entry = {
              language: undefined,
              session,
              restoreSession: (plaintextJson) =>
                pipeline.restoreRedactionSession(plaintextJson),
              status: "ready",
            };
            this.#sessions.set(sessionId, entry);
          } catch (error) {
            throw new AnonymizeSurfaceError(
              "session_unavailable",
              "The requested durable session is unavailable",
              {
                hint: "Confirm the session id and key file match the archive that created it.",
                cause: error,
              },
            );
          }
        }
      } finally {
        this.#sessionInitializations.delete(sessionId);
      }
    }
    if (entry === undefined) {
      throw surfaceError(
        "session_unavailable",
        "The requested session is unavailable",
        "Anonymize with this session id first, or start the server with a durable session store.",
      );
    }
    if (entry.status !== "ready") {
      throw surfaceError(
        "session_unavailable",
        "The requested in-memory session is unavailable",
        "Wait for the prior operation on this session to finish, then retry.",
        true,
      );
    }
    entry.status = "busy";
    return { entry, sessionId, rollback: { type: "release" } };
  }

  async #persistSession(
    sessionId: string,
    session: RedactionSession,
  ): Promise<void> {
    if (this.#durableSessions === undefined) {
      return;
    }
    const archive = this.#durableSessions.seal(
      session,
      observedAtEpochSeconds(),
    );
    await this.#durableSessions.save(sessionId, archive);
  }

  async anonymizeText(
    input: z.infer<typeof textInput>,
  ): Promise<AuditSafeResult> {
    return this.#runOperation(() => this.#anonymizeText(input));
  }

  async anonymizePdf(
    input: z.infer<typeof pdfInput>,
  ): Promise<AuditSafeResult> {
    return this.#runOperation(() =>
      this.#serializePdfOperation(() => this.#anonymizePdf(input)),
    );
  }

  async #serializePdfOperation<Result>(
    operation: () => Promise<Result>,
  ): Promise<Result> {
    const previous = this.#pdfOperationTail;
    let release = (): void => undefined;
    this.#pdfOperationTail = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async #anonymizePdf(
    input: z.infer<typeof pdfInput>,
  ): Promise<AuditSafeResult> {
    const source = await this.#scope.readInput({
      path: input.inputPath,
      extension: ".pdf",
      maximumBytes: PDF_DOCUMENT_MAX_BYTES,
      label: "PDF",
    });
    const destination = await this.#scope.output(input.outputPath, ".pdf");
    assertDifferentPaths(source.path, destination.path);
    const pipeline = nativeNodeSurface.getDefaultNativePipeline(
      input.detectionLanguage === undefined
        ? {}
        : { language: input.detectionLanguage },
    );
    let observed: Awaited<ReturnType<typeof renderPdfWithPopplerTesseract>>;
    try {
      observed = await renderPdfWithPopplerTesseract({
        document: source.bytes,
        ocrLanguage: input.ocrLanguage,
        dpi: input.dpi,
        timeoutMs: input.timeoutMs,
        ...this.#pdfProvider,
      });
    } catch (error) {
      if (isPdfToolchainUnavailable(error)) {
        throw new AnonymizeSurfaceError(
          "dependency_missing",
          "The local PDF toolchain is unavailable",
          {
            hint: "Install Poppler (pdftoppm) and Tesseract on PATH, or pass --pdftoppm/--tesseract.",
            cause: error,
          },
        );
      }
      throw error;
    }
    const anonymized = anonymizePdfRaster({
      document: source.bytes,
      pipeline,
      provider: observed.provider,
      pages: observed.pages,
      fillRgb: input.fillRgb,
    });
    if (
      anonymized.certificate.structurePixelRewriteVerified !== true ||
      anonymized.certificate.piiCleanGuaranteed !== false
    ) {
      throw new Error("PDF raster verification did not satisfy MCP policy");
    }
    await this.#faults.beforeOutputPublish?.();
    await destination.write(anonymized.document);
    return {
      operation: "anonymize",
      format: "pdf",
      outputCreated: true,
      pageCount: anonymized.certificate.pageCount,
      entityCount: anonymized.certificate.detectionCount,
      mappedRegionCount: anonymized.certificate.mappedRegionCount,
      structurePixelRewriteVerified: true,
      piiCleanGuaranteed: false,
    };
  }

  async #anonymizeText(
    input: z.infer<typeof textInput>,
  ): Promise<AuditSafeResult> {
    const source = await this.#scope.readInput({
      path: input.inputPath,
      extension: ".txt",
      maximumBytes: TEXT_MAX_BYTES,
      label: "Text",
    });
    const destination = await this.#scope.output(input.outputPath, ".txt");
    assertDifferentPaths(source.path, destination.path);
    const text = decodeText(source.bytes);
    const lease = await this.#session(input.sessionId, input.language);
    try {
      const result = lease.entry.session.redact_text(text);
      await this.#persistSession(input.sessionId, lease.entry.session);
      await this.#faults.beforeOutputPublish?.();
      await destination.write(result.redaction.redactedText);
      this.#commitSession(lease);
      return {
        operation: "anonymize",
        format: "text",
        outputCreated: true,
        sessionId: input.sessionId,
        entityCount: result.redaction.entityCount,
      };
    } catch (error) {
      await this.#rollbackSession(lease);
      throw error;
    }
  }

  async restoreText(
    input: z.infer<typeof restoreInput>,
  ): Promise<AuditSafeResult> {
    return this.#runOperation(() => this.#restoreText(input));
  }

  async anonymizeTextWithExternalDetections(
    input: z.infer<typeof externalDetectionTextInput>,
  ): Promise<AuditSafeResult> {
    try {
      return await this.#runOperation(() =>
        this.#anonymizeTextWithExternalDetections(input),
      );
    } catch (error) {
      throw externalDetectionFailure(
        error,
        EXTERNAL_DETECTION_FAILURES.operationFailed,
      );
    }
  }

  async #anonymizeTextWithExternalDetections(
    input: z.infer<typeof externalDetectionTextInput>,
  ): Promise<AuditSafeResult> {
    const { batch, destination, source } = await externalDetectionStep(
      EXTERNAL_DETECTION_FAILURES.inputRejected,
      async () => {
        const scopedSource = await this.#scope.readInput({
          path: input.inputPath,
          extension: ".txt",
          maximumBytes: TEXT_MAX_BYTES,
          label: "Text",
        });
        const scopedBatch = await this.#scope.readInput({
          path: input.detectionBatchPath,
          extension: ".json",
          maximumBytes: EXTERNAL_DETECTION_BATCH_MAX_BYTES,
          label: "External detection batch",
        });
        const scopedDestination = await this.#scope.output(
          input.outputPath,
          ".txt",
        );
        assertDifferentPaths(scopedSource.path, scopedDestination.path);
        assertDifferentPaths(scopedBatch.path, scopedDestination.path);
        assertDifferentPaths(scopedSource.path, scopedBatch.path);
        return {
          batch: scopedBatch,
          destination: scopedDestination,
          source: scopedSource,
        };
      },
    );
    const text = await externalDetectionStep(
      EXTERNAL_DETECTION_FAILURES.documentRejected,
      () => decodeText(source.bytes),
    );
    const detections = await externalDetectionStep(
      EXTERNAL_DETECTION_FAILURES.batchRejected,
      () =>
        nativeNodeSurface.convert_external_detection_batch(
          source.bytes,
          decodeUtf8(batch.bytes, "External detection batches"),
        ),
    );
    const lease = await externalDetectionStep(
      EXTERNAL_DETECTION_FAILURES.sessionRejected,
      () => this.#session(input.sessionId, input.language),
    );
    try {
      const plan = lease.entry.session.planTextBatchWithCallerDetections({
        inputs: [{ fullText: text, detections }],
      });
      const block = plan.blocks.at(0);
      if (plan.blocks.length !== 1 || block === undefined) {
        throw new Error(
          "Native caller-detection plan did not match the text input",
        );
      }
      const redactedText = applyTextReplacements(text, block.replacements);
      plan.commit();
      await this.#persistSession(input.sessionId, lease.entry.session);
      await this.#faults.beforeOutputPublish?.();
      await destination.write(redactedText);
      this.#commitSession(lease);
      return {
        operation: "anonymize",
        format: "text",
        outputCreated: true,
        sessionId: input.sessionId,
        entityCount: block.entityCount,
        externalDetectionBatchStatus: "accepted",
        externalDetectionCount: detections.length,
        retainedExternalDetectionCount: block.callerEntityCount,
      };
    } catch (error) {
      await this.#rollbackSession(lease);
      throw externalDetectionFailure(
        error,
        EXTERNAL_DETECTION_FAILURES.operationFailed,
      );
    }
  }

  async #restoreText(
    input: z.infer<typeof restoreInput>,
  ): Promise<AuditSafeResult> {
    const source = await this.#scope.readInput({
      path: input.inputPath,
      extension: ".txt",
      maximumBytes: TEXT_MAX_BYTES,
      label: "Text",
    });
    const destination = await this.#scope.output(input.outputPath, ".txt");
    assertDifferentPaths(source.path, destination.path);
    const text = decodeText(source.bytes);
    const lease = await this.#readSession(input.sessionId);
    try {
      const restored = lease.entry.session.restoreText(text);
      await destination.write(restored);
      this.#commitSession(lease);
      return {
        operation: "restore",
        format: "text",
        outputCreated: true,
        sessionId: input.sessionId,
      };
    } catch (error) {
      await this.#rollbackSession(lease);
      throw error;
    }
  }

  async anonymizeDocx(
    input: z.infer<typeof docxInput>,
  ): Promise<AuditSafeResult> {
    return this.#runOperation(() => this.#anonymizeDocx(input));
  }

  async #anonymizeDocx(
    input: z.infer<typeof docxInput>,
  ): Promise<AuditSafeResult> {
    const source = await this.#scope.readInput({
      path: input.inputPath,
      extension: ".docx",
      maximumBytes: DOCX_ARCHIVE_MAX_BYTES,
      label: "DOCX",
    });
    const destination = await this.#scope.output(input.outputPath, ".docx");
    assertDifferentPaths(source.path, destination.path);
    const lease = await this.#session(input.sessionId, input.language);
    try {
      const result = anonymizeDocx({
        document: source.bytes,
        session: lease.entry.session,
        expectedSessionId: input.sessionId,
        policy: {
          coverage: {
            mode: input.allowPartialCoverage
              ? DOCX_COVERAGE_MODES.allowPartial
              : DOCX_COVERAGE_MODES.requireFull,
          },
        },
      });
      await this.#persistSession(input.sessionId, lease.entry.session);
      await this.#faults.beforeOutputPublish?.();
      await destination.write(result.document);
      this.#commitSession(lease);
      return {
        operation: "anonymize",
        format: "docx",
        outputCreated: true,
        sessionId: input.sessionId,
        entityCount: result.summary.entityCount,
        blockCount: result.summary.blockCount,
        rewrittenBlockCount: result.summary.rewrittenBlockCount,
        coverageStatus: result.summary.coverage.status,
      };
    } catch (error) {
      await this.#rollbackSession(lease);
      throw mapDocxCoverageError(error);
    }
  }

  async restoreDocx(
    input: z.infer<typeof docxRestoreInput>,
  ): Promise<AuditSafeResult> {
    return this.#runOperation(() => this.#restoreDocx(input));
  }

  async #restoreDocx(
    input: z.infer<typeof docxRestoreInput>,
  ): Promise<AuditSafeResult> {
    const source = await this.#scope.readInput({
      path: input.inputPath,
      extension: ".docx",
      maximumBytes: DOCX_ARCHIVE_MAX_BYTES,
      label: "DOCX",
    });
    const destination = await this.#scope.output(input.outputPath, ".docx");
    assertDifferentPaths(source.path, destination.path);
    const lease = await this.#readSession(input.sessionId);
    try {
      const result = restoreDocxText({
        document: source.bytes,
        session: lease.entry.session,
        expectedSessionId: input.sessionId,
      });
      if (result.coverage.status === "partial" && !input.allowPartialCoverage) {
        throw surfaceError(
          "validation_error",
          "DOCX restoration has partial coverage; set allowPartialCoverage to publish it",
          "Re-run with allowPartialCoverage: true to accept partial restoration.",
        );
      }
      await destination.write(result.document);
      this.#commitSession(lease);
      return {
        operation: "restore",
        format: "docx",
        outputCreated: true,
        sessionId: input.sessionId,
        rewrittenBlockCount: result.restoredBlockCount,
        restoredPlaceholderCount: result.restoredPlaceholderCount,
        coverageStatus: result.coverage.status,
      };
    } catch (error) {
      await this.#rollbackSession(lease);
      throw error;
    }
  }

  async inspectDocx(inputPath: string): Promise<AuditSafeResult> {
    return this.#runOperation(() => this.#inspectDocx(inputPath));
  }

  async #inspectDocx(inputPath: string): Promise<AuditSafeResult> {
    const source = await this.#scope.readInput({
      path: inputPath,
      extension: ".docx",
      maximumBytes: DOCX_ARCHIVE_MAX_BYTES,
      label: "DOCX",
    });
    const extraction = extractDocxText(source.bytes);
    const unsupported = extraction.coverage.parts.some(
      (part) => part.status === "unsupported",
    );
    const structuralGap =
      extraction.coverage.hyperlinkTextSegmentCount > 0 ||
      extraction.coverage.revisionTextSegmentCount > 0 ||
      extraction.coverage.unsupportedAlternateContentCount > 0 ||
      extraction.coverage.unsupportedFieldInstructionCount > 0 ||
      extraction.coverage.unsupportedSymbolCount > 0;
    return {
      operation: "inspect",
      format: "docx",
      outputCreated: false,
      blockCount: extraction.blocks.length,
      coverageStatus: unsupported || structuralGap ? "partial" : "full",
    };
  }
}

const result = (value: AuditSafeResult): CallToolResult => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  structuredContent: { ...value },
});

const MCP_TOOL_NAMES = [
  "anonymize_docx_file",
  "anonymize_pdf_file",
  "anonymize_text_file",
  "anonymize_text_file_with_external_detections",
  "capabilities",
  "inspect_docx_file",
  "restore_docx_file",
  "restore_text_file",
  "send_feedback",
] as const;

/**
 * Map the external-detection failure taxonomy onto the shared agent-surface
 * codes. The specific failure identity is preserved in the envelope `message`;
 * `code` gives the agent the coarse, branchable class.
 */
const EXTERNAL_DETECTION_ENVELOPE: Record<
  ExternalDetectionFailure["code"],
  { code: AnonymizeErrorCode; hint: string; retryable: boolean }
> = {
  EXTERNAL_DETECTION_BATCH_REJECTED: {
    code: "validation_error",
    hint: "Fix the ExternalDetectionBatch v1 sidecar to match the schema and retry.",
    retryable: false,
  },
  EXTERNAL_DETECTION_DOCUMENT_REJECTED: {
    code: "validation_error",
    hint: "Align the sidecar's document metadata with the input, then retry.",
    retryable: false,
  },
  EXTERNAL_DETECTION_INPUT_REJECTED: {
    code: "validation_error",
    hint: "Use distinct absolute paths inside a configured --root for input, sidecar, and output.",
    retryable: false,
  },
  EXTERNAL_DETECTION_OPERATION_FAILED: {
    code: "internal_error",
    hint: "Retry; if it persists, file it with the send_feedback tool.",
    retryable: true,
  },
  EXTERNAL_DETECTION_SESSION_REJECTED: {
    code: "session_unavailable",
    hint: "Use a fresh session id, or confirm the session store and key file match.",
    retryable: false,
  },
};

const toEnvelope = (error: unknown): AnonymizeErrorEnvelope => {
  if (error instanceof ExternalDetectionAuditError) {
    const mapped = EXTERNAL_DETECTION_ENVELOPE[error.code];
    return {
      error: {
        code: mapped.code,
        message: error.message,
        hint: mapped.hint,
        retryable: mapped.retryable,
      },
    };
  }
  return classifyToEnvelope(error);
};

const errorResult = (error: unknown): CallToolResult => {
  const envelope = toEnvelope(error);
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(envelope) }],
    structuredContent: { ...envelope },
  };
};

/**
 * Run a tool body, rendering any thrown error as the structured envelope so
 * every tool fails the same, agent-legible way instead of surfacing a raw
 * protocol error.
 */
const guard = async (
  produce: () => CallToolResult | Promise<CallToolResult>,
): Promise<CallToolResult> => {
  try {
    return await produce();
  } catch (error) {
    return errorResult(error);
  }
};

const capabilitiesResult = async (
  service: LocalAnonymizeService,
): Promise<CallToolResult> => {
  await preloadNativeBinding();
  const value = {
    capabilityManifest: CAPABILITY_MANIFEST,
    runtimeVersion: nativeNodeSurface.native_package_version(),
    mcp: {
      externalDetectionBatch: {
        ingestion: "path-only" as const,
        version: EXTERNAL_DETECTION_BATCH_VERSION,
      },
      formats: ["docx", "pdf", "text"] as const,
      sessionMode: service.sessionMode,
      tools: MCP_TOOL_NAMES,
      transport: "stdio" as const,
    },
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
};

const feedbackInput = z.object({
  kind: z.enum(FEEDBACK_KINDS),
  title: z.string().min(1).max(MAX_FEEDBACK_TITLE_CHARS),
  body: z.string().min(1).max(MAX_FEEDBACK_BODY_CHARS),
});

const feedbackResult = (
  input: z.infer<typeof feedbackInput>,
): CallToolResult => {
  const submission = buildFeedbackSubmission(input);
  const value = {
    channel: "github" as const,
    redactions: submission.redactions,
    title: submission.title,
    sanitizedBody: submission.sanitizedBody,
    issueUrl: submission.issueUrl,
    ghCommand: submission.ghCommand,
    note: "Nothing was sent. Review the sanitized content, then open the URL (or run the gh command) to submit the issue under your own GitHub account.",
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: { ...value },
  };
};

/**
 * Server `instructions` handed to MCP clients at connect time. Kept terse and
 * factual; the char budget is asserted in `instructions.test.ts` to guard drift.
 */
export const MCP_INSTRUCTIONS_MAX_CHARS = 1200;
export const MCP_INSTRUCTIONS = `stella-anonymize redacts PII in local text, DOCX, and PDF files. Every tool reads and writes local paths only, inside the directories passed as --root; it never returns document text or session mappings, and it never overwrites, so outputs must be new paths.

Errors: a failed tool returns a single text content of {"error":{"code","message","hint","retryable"}} with isError set. Branch on code (validation_error, path_not_allowed, not_found, unsupported_format, output_exists, session_unavailable, dependency_missing, internal_error); hint states the next step. Nothing here is destructive: there is no delete and existing files are never overwritten, so no confirm step is needed.

Sessions: reversible replace mode uses a session; a restore needs the same session id, plus a durable store (server started with --session-dir and --key-file) to survive a restart.

Hit a bug or a gap? Use send_feedback: it sanitizes your text locally and returns a prefilled GitHub issue URL you open and submit yourself. It sends nothing over the network.`;

export const createAnonymizeMcpServer = (
  service: LocalAnonymizeService,
): McpServer => {
  // Synchronous by contract (public factory). The server version comes from the
  // package manifest, not a native call, so construction touches no binding; the
  // wasm binding is preloaded lazily on the first operation (see `#runOperation`).
  const server = new McpServer(
    {
      name: "stella-anonymize-local",
      version: pkg.version,
    },
    {
      instructions: MCP_INSTRUCTIONS,
    },
  );
  server.registerTool(
    "capabilities",
    {
      description:
        "Return the public runtime capability manifest and MCP surface metadata.",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async () => guard(() => capabilitiesResult(service)),
  );
  server.registerTool(
    "anonymize_text_file",
    {
      description: "Anonymize a local UTF-8 text file into a new local file.",
      inputSchema: textInput,
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    async (input) =>
      guard(async () => result(await service.anonymizeText(input))),
  );
  server.registerTool(
    "restore_text_file",
    {
      description: "Restore a text file using the configured session store.",
      inputSchema: restoreInput,
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    async (input) =>
      guard(async () => result(await service.restoreText(input))),
  );
  server.registerTool(
    "anonymize_text_file_with_external_detections",
    {
      description:
        "Anonymize a local UTF-8 text file with a provider-neutral ExternalDetectionBatch v1 JSON sidecar into a new local file.",
      inputSchema: externalDetectionTextInput,
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    async (input) =>
      guard(async () =>
        result(await service.anonymizeTextWithExternalDetections(input)),
      ),
  );
  server.registerTool(
    "anonymize_docx_file",
    {
      description:
        "Structure-preservingly anonymize a local DOCX into a new local DOCX.",
      inputSchema: docxInput,
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    async (input) =>
      guard(async () => result(await service.anonymizeDocx(input))),
  );
  server.registerTool(
    "anonymize_pdf_file",
    {
      description:
        "Destructively raster-anonymize a local PDF into a fresh image-only PDF. Returns aggregate verification only; it does not claim perfect OCR or detector recall.",
      inputSchema: pdfInput,
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    async (input) =>
      guard(async () => result(await service.anonymizePdf(input))),
  );
  server.registerTool(
    "restore_docx_file",
    {
      description: "Restore a DOCX using the configured session store.",
      inputSchema: docxRestoreInput,
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    async (input) =>
      guard(async () => result(await service.restoreDocx(input))),
  );
  server.registerTool(
    "inspect_docx_file",
    {
      description:
        "Return only aggregate DOCX coverage and block counts; never document text.",
      inputSchema: z.object({
        inputPath: z.string().min(1).max(PATH_MAX_CHARACTERS),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ inputPath }) =>
      guard(async () => result(await service.inspectDocx(inputPath))),
  );
  server.registerTool(
    "send_feedback",
    {
      description:
        "File a bug, feature request, or docs issue with the stella-anonymize maintainers. Sanitizes the title and body locally (emails, ids, secrets, URLs, IPs are redacted) and returns a prefilled GitHub new-issue URL and a gh command that you open and submit under your own account. It sends nothing over the network and publishes nothing on its own. Never include document text, client names, ids, or secrets; describe the problem, steps, and expected vs actual result.",
      inputSchema: feedbackInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => guard(() => feedbackResult(input)),
  );
  return server;
};
