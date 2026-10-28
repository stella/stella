import { Result } from "better-result";
import { SaxesParser } from "saxes";

import { isRecord } from "../shared/guards.js";
import { performRegistryRequest } from "../shared/http.js";
import type { RegistryRequestObservation } from "../shared/request-observer.js";
import {
  EntityCheckCancelledError,
  EntityCheckUnavailableError,
  unavailable,
} from "./result.js";
import type { EntityCheckSourceError } from "./result.js";

// Minimal SOAP 1.1 transport for the entity-check sources. Every way the
// exchange can go wrong ends in an `EntityCheckUnavailableError`; the caller
// only ever sees a parsed SOAP Body that it must still shape-check.

const XML_SPECIAL_CHARACTERS: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

export const escapeXml = (value: string): string =>
  value.replaceAll(/[&<>"']/gu, (char) => XML_SPECIAL_CHARACTERS[char] ?? "");

const HTML_DOCUMENT = /^\s*(?:<\?xml[^>]*>\s*)?(?:<!doctype\s+html|<html)/iu;
const DOCUMENT_TYPE_DECLARATION = /<!doctype|<!entity/iu;

const isTimeoutError = (error: unknown): boolean =>
  error instanceof DOMException && error.name === "TimeoutError";

/** Classify a rejected request or body read. */
const requestFailure = (
  cause: unknown,
  signal: AbortSignal | undefined,
): EntityCheckSourceError => {
  if (signal?.aborted) {
    return new EntityCheckCancelledError({
      message: "The check was cancelled",
    });
  }
  if (EntityCheckUnavailableError.is(cause)) {
    return cause;
  }
  return isTimeoutError(cause)
    ? new EntityCheckUnavailableError({
        reason: "timeout",
        detail: null,
        message: "The source did not answer in time",
      })
    : new EntityCheckUnavailableError({
        reason: "network",
        detail: null,
        message: "The source could not be reached",
      });
};

type SoapRequestOptions = {
  observer: RegistryRequestObservation;
  url: string;
  soapAction: string;
  /** Namespace declarations for the envelope, keyed by prefix. */
  namespaces: Record<string, string>;
  /** Body content, already XML-escaped by the caller. */
  body: string;
  /** Element names that may repeat and must always parse as arrays. */
  repeatedElements: ReadonlySet<string>;
  signal?: AbortSignal | undefined;
};

const buildEnvelope = ({
  namespaces,
  body,
}: Pick<SoapRequestOptions, "namespaces" | "body">): string => {
  const declarations = Object.entries(namespaces)
    .map(([prefix, uri]) => ` xmlns:${prefix}="${escapeXml(uri)}"`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"${declarations}><soapenv:Header/><soapenv:Body>${body}</soapenv:Body></soapenv:Envelope>`;
};

type XmlObject = Record<string, unknown>;

type OpenElement = {
  name: string;
  attributes: Map<string, string>;
  children: Map<string, unknown>;
  /** Text since the last tag, comments included; trimmed when a tag ends it. */
  pendingText: string;
  text: string;
};

/**
 * A qualified name without its namespace prefix; `null` for a namespace
 * declaration, which the parsed document does not carry.
 */
const unprefixedName = (name: string): string | null => {
  const parts = name.split(":");
  if (parts[0] === "xmlns") {
    return null;
  }
  return parts.length === 2 ? (parts[1] ?? name) : name;
};

const flushText = (element: OpenElement): void => {
  const text = element.pendingText.trim();
  element.pendingText = "";
  if (text.length > 0) {
    element.text += text;
  }
};

type AddChildOptions = {
  children: Map<string, unknown>;
  name: string;
  value: unknown;
  repeatedElements: ReadonlySet<string>;
};

const addChild = ({
  children,
  name,
  value,
  repeatedElements,
}: AddChildOptions): void => {
  const existing = children.get(name);
  if (existing === undefined) {
    children.set(name, repeatedElements.has(name) ? [value] : value);
  } else if (Array.isArray(existing)) {
    existing.push(value);
  } else {
    children.set(name, [existing, value]);
  }
};

/** An element with neither attributes nor child elements reads as its text. */
const elementValue = (element: OpenElement): unknown => {
  if (element.children.size === 0 && element.attributes.size === 0) {
    return element.text;
  }
  return Object.fromEntries([
    ...element.children,
    ...element.attributes,
    ...(element.text.length > 0 ? [["#text", element.text] as const] : []),
  ]);
};

type ParsedXmlDocument =
  { status: "parsed"; document: XmlObject } | { status: "malformed" };

/**
 * Read a SOAP response in one strict pass. A document that is not well-formed
 * (truncated, mismatched, an undeclared entity) is refused rather than read
 * as far as it goes.
 *
 * Names lose their namespace prefix, attributes are `@`-prefixed, values stay
 * strings, text is trimmed (CDATA is kept as written), an element with
 * neither attributes nor children reads as its text, a name that repeats
 * becomes an array, and a name in `repeatedElements` is always one.
 */
export const parseXmlDocument = (
  text: string,
  repeatedElements: ReadonlySet<string>,
): ParsedXmlDocument => {
  const root: OpenElement = {
    name: "",
    attributes: new Map(),
    children: new Map(),
    pendingText: "",
    text: "",
  };
  const stack: OpenElement[] = [root];
  let malformed = false;
  const parser = new SaxesParser();
  parser.on("error", () => {
    malformed = true;
  });
  parser.on("text", (value) => {
    const current = stack.at(-1);
    if (current) {
      current.pendingText += value;
    }
  });
  parser.on("cdata", (value) => {
    const current = stack.at(-1);
    if (!current) {
      return;
    }
    flushText(current);
    current.text += value;
  });
  parser.on("opentag", (tag) => {
    const parent = stack.at(-1);
    if (parent) {
      flushText(parent);
    }
    const attributes = new Map<string, string>();
    for (const [qualifiedName, value] of Object.entries(tag.attributes)) {
      const name = unprefixedName(qualifiedName);
      if (name !== null && name !== "") {
        attributes.set(`@${name}`, value.trim());
      }
    }
    stack.push({
      name: unprefixedName(tag.name) ?? tag.name,
      attributes,
      children: new Map(),
      pendingText: "",
      text: "",
    });
  });
  parser.on("closetag", () => {
    const element = stack.pop();
    const parent = stack.at(-1);
    if (!element || !parent) {
      return;
    }
    flushText(element);
    addChild({
      children: parent.children,
      name: element.name,
      value: elementValue(element),
      repeatedElements,
    });
  });
  const written = Result.try(() => parser.write(text).close());
  return written.isErr() || malformed
    ? { status: "malformed" }
    : { status: "parsed", document: Object.fromEntries(root.children) };
};

export const isWellFormedXml = (text: string): boolean =>
  parseXmlDocument(text, new Set()).status === "parsed";

type SoapResponse = { status: number; contentType: string; text: string };

const readSoapBody = (
  { status, contentType, text }: SoapResponse,
  repeatedElements: ReadonlySet<string>,
): Result<Record<string, unknown>, EntityCheckUnavailableError> => {
  const httpStatus = String(status);
  // Outage pages are frequently served with HTTP 200.
  if (HTML_DOCUMENT.test(text) || contentType.includes("text/html")) {
    return unavailable({
      reason: "outage-page",
      message: "The source returned an HTML page instead of a SOAP response",
      detail: httpStatus,
    });
  }
  // SOAP forbids document type declarations; refusing them also keeps
  // entity expansion out of the parser.
  const parsed = DOCUMENT_TYPE_DECLARATION.test(text)
    ? null
    : parseXmlDocument(text, repeatedElements);
  if (parsed === null || parsed.status === "malformed") {
    return unavailable({
      reason: "malformed-response",
      message: "The source returned a response that is not well-formed XML",
      detail: httpStatus,
    });
  }
  const envelope = parsed.document["Envelope"];
  const body = isRecord(envelope) ? envelope["Body"] : undefined;
  if (!isRecord(body)) {
    return unavailable({
      reason: "malformed-response",
      message: "The source response has no SOAP body",
      detail: httpStatus,
    });
  }
  const fault = body["Fault"];
  if (fault !== undefined) {
    const faultCode =
      isRecord(fault) && typeof fault["faultcode"] === "string"
        ? fault["faultcode"]
        : null;
    return unavailable({
      reason: "soap-fault",
      message: "The source answered with a SOAP fault",
      detail: faultCode,
    });
  }
  if (status < 200 || status > 299) {
    return unavailable({
      reason: "http-error",
      message: `The source answered with HTTP ${httpStatus}`,
      detail: httpStatus,
    });
  }
  return Result.ok(body);
};

/**
 * POST a SOAP request and return the parsed `Body` element with namespace
 * prefixes removed. Attributes are exposed with an `@` prefix and every
 * value stays a string: identifiers such as `00121100` keep their zeros.
 */
export const soapRequest = async (
  options: SoapRequestOptions,
): Promise<Result<Record<string, unknown>, EntityCheckSourceError>> =>
  await Result.gen(async function* () {
    const response = yield* Result.await(
      Result.tryPromise({
        try: async () =>
          await performRegistryRequest({
            url: options.url,
            observer: options.observer,
            init: {
              method: "POST",
              headers: {
                "Content-Type": "text/xml; charset=utf-8",
                SOAPAction: `"${options.soapAction}"`,
              },
              body: buildEnvelope(options),
            },
            signal: options.signal,
            wrapRequestError: (cause) =>
              new Error("SOAP request failed", { cause }),
          }),
        catch: (error) =>
          requestFailure(
            error instanceof Error && error.cause !== undefined
              ? error.cause
              : error,
            options.signal,
          ),
      }),
    );
    const text = yield* Result.await(
      Result.tryPromise({
        try: async () => await response.text(),
        catch: (error) => requestFailure(error, options.signal),
      }),
    );
    return readSoapBody(
      {
        status: response.status,
        contentType: response.headers.get("content-type") ?? "",
        text,
      },
      options.repeatedElements,
    );
  });
