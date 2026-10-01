import { describe, expect, test } from "bun:test";

import {
  DOCUMENT_FETCH_ERROR_KIND,
  DOCUMENT_FETCH_EVENT,
  DOCUMENT_FETCH_OUTCOME,
  documentErrorDiagnostics,
  documentFetchErrorOutcome,
  documentFetchResponseOutcome,
  documentResponseDiagnostics,
  type DocumentFetchOutcome,
} from "./document-fetch-diagnostics";

const errorWithCode = (code: string) =>
  Object.assign(new Error("private publisher payload"), { code });

const ERROR_FIXTURES = {
  http_4xx: Object.assign(new Error("private"), { httpStatus: 404 }),
  http_5xx: Object.assign(new Error("private"), { httpStatus: 503 }),
  rate_limited: Object.assign(new Error("private"), { httpStatus: 429 }),
  timeout: new DOMException("private", "TimeoutError"),
  connection: errorWithCode("ECONNRESET"),
  tls: errorWithCode("CERT_HAS_EXPIRED"),
  body_shape: Object.assign(new Error("private"), {
    documentFetchFailureKind: DOCUMENT_FETCH_ERROR_KIND.bodyShape,
  }),
  publisher_refusal: Object.assign(new Error("private"), { httpStatus: 403 }),
  unknown: new Error("HTTP 429 TLS timeout ECONNRESET private"),
} satisfies Record<Exclude<DocumentFetchOutcome, "ok">, Error>;

describe("source-generic document fetch diagnostics", () => {
  test("every failure outcome is classified by structured context without leaking content", () => {
    for (const [outcome, error] of Object.entries(ERROR_FIXTURES)) {
      const observation = documentFetchErrorOutcome("fixture-source", error);
      expect(observation.source).toBe("fixture-source");
      expect(observation.event).toBe(DOCUMENT_FETCH_EVENT.fetchOutcome);
      expect(observation.outcome).toBe(outcome);
      expect(JSON.stringify(observation)).not.toContain("private");
      expect(Object.keys(observation).toSorted()).toEqual(
        ("httpStatus" in error
          ? ["event", "source", "outcome", "http_status"]
          : ["event", "source", "outcome"]
        ).toSorted(),
      );
    }
  });

  test("the complete HTTP status space respects classes and special refusals", () => {
    for (let status = 200; status <= 599; status++) {
      const observation = documentFetchResponseOutcome(
        "fixture-source",
        new Response(null, { status }),
      );
      expect(observation.http_status).toBe(status);
      if (status < 300) {
        expect(observation.outcome).toBe(DOCUMENT_FETCH_OUTCOME.ok);
      } else if (status < 400) {
        expect(observation.outcome).toBe(DOCUMENT_FETCH_OUTCOME.unknown);
      } else if (status === 429) {
        expect(observation.outcome).toBe(DOCUMENT_FETCH_OUTCOME.rateLimited);
      } else if (status === 401 || status === 403) {
        expect(observation.outcome).toBe(
          DOCUMENT_FETCH_OUTCOME.publisherRefusal,
        );
      } else if (status < 500) {
        expect(observation.outcome).toBe(DOCUMENT_FETCH_OUTCOME.http4xx);
      } else {
        expect(observation.outcome).toBe(DOCUMENT_FETCH_OUTCOME.http5xx);
      }
    }
    expect(
      documentFetchErrorOutcome(
        "source",
        Object.assign(new Error("redirect"), { httpStatus: 302 }),
      ).outcome,
    ).toBe("unknown");
  });

  test("wrapped transport failures retain their cause, with bounded cycle handling", () => {
    for (const [outcome, cause] of Object.entries(ERROR_FIXTURES)) {
      expect(
        documentFetchErrorOutcome("source", new Error("wrapper", { cause }))
          .outcome,
      ).toBe(outcome);
    }
    const circular = new Error("private");
    circular.cause = circular;
    expect(documentFetchErrorOutcome("source", circular).outcome).toBe(
      "unknown",
    );
    let deep = new Error("private", { cause: errorWithCode("ECONNREFUSED") });
    for (let depth = 0; depth < 10; depth++) {
      deep = new Error("private", { cause: deep });
    }
    expect(documentFetchErrorOutcome("source", deep).outcome).toBe("unknown");
    for (const error of [
      undefined,
      null,
      "ECONNRESET",
      429,
      { code: "ECONNRESET" },
    ]) {
      expect(documentFetchErrorOutcome("source", error).outcome).toBe(
        "unknown",
      );
    }
  });

  test("transport and decoder kinds remain distinct from message text", () => {
    for (const code of [
      "ETIMEDOUT",
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_HEADERS_TIMEOUT",
      "UND_ERR_BODY_TIMEOUT",
    ]) {
      expect(documentErrorDiagnostics(errorWithCode(code)).kind).toBe(
        "timeout",
      );
    }
    for (const code of [
      "ECONNRESET",
      "ECONNREFUSED",
      "ENOTFOUND",
      "EAI_AGAIN",
      "ConnectionClosed",
    ]) {
      expect(documentErrorDiagnostics(errorWithCode(code)).kind).toBe(
        "network",
      );
    }
    for (const code of [
      "ERR_TLS_CERT_ALTNAME_INVALID",
      "CERT_HAS_EXPIRED",
      "DEPTH_ZERO_SELF_SIGNED_CERT",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
    ]) {
      expect(documentErrorDiagnostics(errorWithCode(code)).kind).toBe("tls");
    }
    expect(
      documentErrorDiagnostics(new DOMException("private", "AbortError")).kind,
    ).toBe("aborted");
    expect(
      documentFetchErrorOutcome(
        "source",
        Object.assign(new Error("private"), {
          documentFetchFailureKind: "non-pdf",
        }),
      ).outcome,
    ).toBe("body_shape");
    expect(
      documentFetchErrorOutcome(
        "source",
        Object.assign(new Error("private"), {
          documentFetchFailureKind: "arbitrary-private",
        }),
      ).outcome,
    ).toBe("unknown");
  });

  test("response MIME classes are bounded and strip header parameters", () => {
    for (const [mime, expected] of [
      ["Application/PDF; filename=private", "pdf"],
      ["application/octet-stream", "binary"],
      ["text/html", "html"],
      ["application/json", "json"],
      ["application/problem+json", "json"],
      ["text/private", "other"],
      ["", "missing"],
    ] as const) {
      expect(
        documentResponseDiagnostics(
          new Response(null, { headers: { "content-type": mime } }),
        ).contentTypeClass,
      ).toBe(expected);
    }
    expect(
      documentResponseDiagnostics(new Response(null)).contentTypeClass,
    ).toBe("missing");
    expect(documentResponseDiagnostics(Response.error()).httpStatusClass).toBe(
      "other",
    );
  });
});
