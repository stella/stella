// How a capability's payload crosses the generic JSON transport
// (`invoke_capability` and the generated CLI). Declared on the handler config as
// `transport` and projected verbatim into the capability catalog, from which the
// CLI, `list_capabilities`, and `describe_capability` all read.
//
// This replaces two coarse booleans (`requiresFileInput`, `returnsFileResponse`)
// that could only say "file-shaped, therefore unreachable". They could not say
// WHICH field carries the bytes, whether those bytes are optional (so the
// capability also has a JSON-only mode), or where the same work can be done over
// a transport that does carry bytes. The catalog is what an agent reads before
// choosing a call, so each omission was a small lie: `templates.prefill` was
// dropped from every client although two of its three source modes are plain
// JSON, and every excluded entry said only "not available" with no route
// forward.
//
// No module-level side effects: types plus pure predicates, so the exporter, the
// handler configs, and the MCP layer can all import it.

import { panic } from "better-result";

/**
 * Where the same work can be done over a transport that is not this one. Stated
 * per file-shaped capability because "not available here" without a next step is
 * a dead end for the agent reading it. `none` carries a reason so the absence is
 * a reviewed statement rather than an omission.
 */
export type CapabilityTransportAlternative =
  | { type: "none"; reason: string }
  | { type: "mcp-tool"; name: string; note: string }
  | {
      /** Another capability achieves the same end result entirely over JSON. */
      type: "complete";
      /** Catalog ids to call, in order. */
      via: readonly string[];
      /** How the alternative is driven, in one sentence. */
      note: string;
    }
  | {
      /** Another capability does the same operation minus a named limitation. */
      type: "partial";
      via: readonly string[];
      /** What the alternative cannot do, in one sentence. */
      limitation: string;
    };

/** The body field carrying bytes, for a capability that accepts a file. */
export type CapabilityFileInput = {
  /**
   * Body property whose schema is `format: "binary"` (`t.File()`/`t.Files()`).
   * The exporter cross-checks this against the live schema, so it cannot name a
   * field that is not there.
   */
  field: string;
  /**
   * `false` when the field is `t.Optional(...)`, which means the capability has
   * a fileless mode: it stays invokable over JSON as long as the field is
   * omitted. The exporter cross-checks this against the schema's `required`
   * list, so flipping optionality fails the export until the transport is
   * re-reviewed.
   */
  required: boolean;
  /**
   * Media types the handler accepts, as enforced in the handler body (empty when
   * it accepts any). Not derivable from the schema: `t.File()` carries only a
   * size cap. The cap itself is not repeated here — it is already in the entry's
   * `inputSchema` as `maxSize`, and a second copy would be a drift surface.
   */
  mediaTypes: readonly string[];
};

/** The bytes a capability returns on success, for a file-response capability. */
export type CapabilityFileResponse = {
  /**
   * Every media type the success path can produce. A list, not a single value:
   * one endpoint legitimately serves several (`views.table-export` renders csv,
   * xlsx, or docx from the same `format` query).
   */
  mediaTypes: readonly string[];
};

/**
 * Total transport disposition for one capability. `json` is the ordinary case:
 * the payload crosses the generic transport in both directions. The three file
 * variants each carry the concrete field/media types plus the alternative
 * transport, so a client can explain the exclusion instead of restating it.
 */
export type CapabilityTransport =
  | { type: "json" }
  | {
      type: "file-input";
      input: CapabilityFileInput;
      alternative: CapabilityTransportAlternative;
    }
  | {
      type: "file-response";
      response: CapabilityFileResponse;
      alternative: CapabilityTransportAlternative;
    }
  | {
      type: "file-both";
      input: CapabilityFileInput;
      response: CapabilityFileResponse;
      alternative: CapabilityTransportAlternative;
    };

/** The file-input leg of a transport, or `undefined` for a transport without one. */
export const transportFileInput = (
  transport: CapabilityTransport,
): CapabilityFileInput | undefined => {
  switch (transport.type) {
    case "json":
    case "file-response":
      return undefined;
    case "file-input":
    case "file-both":
      return transport.input;
    default: {
      transport satisfies never;
      return panic(`Unhandled transport: ${String(transport)}`);
    }
  }
};

/** The file-response leg of a transport, or `undefined` for a transport without one. */
export const transportFileResponse = (
  transport: CapabilityTransport,
): CapabilityFileResponse | undefined => {
  switch (transport.type) {
    case "json":
    case "file-input":
      return undefined;
    case "file-response":
    case "file-both":
      return transport.response;
    default: {
      transport satisfies never;
      return panic(`Unhandled transport: ${String(transport)}`);
    }
  }
};

/** The alternative transport, or `undefined` for a plain JSON capability. */
export const transportAlternative = (
  transport: CapabilityTransport,
): CapabilityTransportAlternative | undefined => {
  switch (transport.type) {
    case "json":
      return undefined;
    case "file-input":
    case "file-response":
    case "file-both":
      return transport.alternative;
    default: {
      transport satisfies never;
      return panic(`Unhandled transport: ${String(transport)}`);
    }
  }
};

/**
 * THE reachability predicate: whether the generic JSON transport can run this
 * capability at all. A file response can never be serialized, so any transport
 * carrying one is out; a REQUIRED file input cannot be supplied over JSON (a
 * plain string would pass `format: "binary"` validation and reach a handler
 * expecting a `File`), so that is out too. An OPTIONAL file input leaves a
 * fileless mode, which stays invokable as long as the field is omitted — see
 * `filelessOnlyField`.
 *
 * The CLI mirrors this predicate on its own copy of the catalog type
 * (`packages/cli/src/generate-capability-tree.ts`); the exporter asserts the two
 * agree by building the real CLI route tree and comparing its capability-leaf
 * set against this predicate's verdict, in both directions.
 */
export const isTransportInvocable = (
  transport: CapabilityTransport,
): boolean => {
  switch (transport.type) {
    case "json":
      return true;
    case "file-input":
      return !transport.input.required;
    case "file-response":
    case "file-both":
      return false;
    default: {
      transport satisfies never;
      return panic(`Unhandled transport: ${String(transport)}`);
    }
  }
};

/**
 * For an invocable capability that still has a file field, the field a JSON
 * caller must omit; `undefined` when there is nothing to omit. Every client
 * hides this field from its input surface and refuses it when supplied, rather
 * than passing a string through to a handler that expects a `File`.
 */
export const filelessOnlyField = (
  transport: CapabilityTransport,
): string | undefined => {
  if (transport.type !== "file-input" || transport.input.required) {
    return undefined;
  }
  return transport.input.field;
};

/**
 * One-line recovery text naming where the work can be done instead. Shared by
 * the MCP refusal hint, `describe_capability`, and the generated coverage doc so
 * an agent, a reviewer, and a CLI user all read the same sentence.
 */
export const describeTransportAlternative = (
  alternative: CapabilityTransportAlternative,
): string => {
  switch (alternative.type) {
    case "none":
      return `No JSON-transport alternative: ${alternative.reason}`;
    case "mcp-tool":
      return `Call the ${alternative.name} MCP tool directly: ${alternative.note}`;
    case "complete":
      return `Use ${alternative.via.join(" then ")} instead: ${alternative.note}`;
    case "partial":
      return `${alternative.via.join(" then ")} covers part of this: ${alternative.limitation}`;
    default: {
      alternative satisfies never;
      return panic(`Unhandled alternative: ${String(alternative)}`);
    }
  }
};
