import { Result } from "better-result";
import { XMLParser, XMLValidator } from "fast-xml-parser";

import { isRecord } from "../shared/guards.js";
import { performRegistryRequest } from "../shared/http.js";
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

export type SoapRequestOptions = {
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
  if (
    DOCUMENT_TYPE_DECLARATION.test(text) ||
    XMLValidator.validate(text) !== true
  ) {
    return unavailable({
      reason: "malformed-response",
      message: "The source returned a response that is not well-formed XML",
      detail: httpStatus,
    });
  }
  const parser = new XMLParser({
    removeNSPrefix: true,
    ignoreAttributes: false,
    attributeNamePrefix: "@",
    parseTagValue: false,
    parseAttributeValue: false,
    isArray: (name) => repeatedElements.has(name),
  });
  const parsed: unknown = parser.parse(text);
  const envelope = isRecord(parsed) ? parsed["Envelope"] : undefined;
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
