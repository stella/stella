import { afterEach, describe, expect, mock, test } from "bun:test";

import { getConsolidatedLaw, searchConsolidatedLegislation } from "./client.js";

const originalFetch = globalThis.fetch;

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status: 200,
  });

const xmlResponse = (body: string) =>
  new Response(body, {
    headers: { "content-type": "application/xml" },
    status: 200,
  });

const getRequestUrl = (input: RequestInfo | URL) => {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
};

const installFetch = (
  handler: (
    url: string,
    init: RequestInit | undefined,
  ) => Promise<Response> | Response,
) => {
  const fetchMock = mock(
    async (input: RequestInfo | URL, init?: RequestInit) =>
      await handler(getRequestUrl(input), init),
  );
  globalThis.fetch = Object.assign(fetchMock, {
    preconnect: originalFetch.preconnect,
  });
  return fetchMock;
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("BOE client", () => {
  test("sends publication date filters only through the search DSL", async () => {
    const hit = {
      identificador: "BOE-A-1889-4763",
      titulo:
        "Real Decreto de 24 de julio de 1889 por el que se publica el Código Civil.",
    };

    const fetchMock = installFetch((url, init) => {
      const requestUrl = new URL(url);
      expect(requestUrl.searchParams.has("from")).toBe(false);
      expect(requestUrl.searchParams.has("to")).toBe(false);
      expect(requestUrl.searchParams.get("limit")).toBe("10");
      expect(requestUrl.searchParams.get("query")).toContain(
        '"fecha_publicacion"',
      );
      expect(new Headers(init?.headers).get("accept")).toBe("application/json");
      return jsonResponse({
        data: [hit],
        status: { code: "200", text: "ok" },
      });
    });

    const response = await searchConsolidatedLegislation({
      dateFrom: "18890101",
      dateTo: "18891231",
      limit: 10,
      title: "Código Civil",
    });

    expect(response.data).toEqual([hit]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("keeps missing optional law sections from failing the whole request", async () => {
    const metadata = { identificador: "BOE-A-1889-4763" };

    installFetch((url, init) => {
      const accept = new Headers(init?.headers).get("accept");

      if (url.endsWith("/metadatos")) {
        expect(accept).toBe("application/json");
        return jsonResponse({ data: metadata, status: { code: "200" } });
      }

      if (url.endsWith("/analisis") || url.endsWith("/metadata-eli")) {
        return new Response(null, { status: 404 });
      }

      if (url.endsWith("/texto")) {
        expect(accept).toBe("application/xml");
        return xmlResponse("<texto />");
      }

      throw new Error(`Unexpected BOE request: ${url}`);
    });

    const response = await getConsolidatedLaw("BOE-A-1889-4763", {
      analysis: true,
      eli: true,
      fullText: true,
      metadata: true,
    });

    expect(response).toEqual({
      analysis: null,
      eli: null,
      fullText: "<texto />",
      lawId: "BOE-A-1889-4763",
      metadata,
    });
  });
});
