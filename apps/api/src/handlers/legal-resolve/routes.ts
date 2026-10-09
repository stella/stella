import Elysia, { t } from "elysia";

import { authorizeLegalResolveRequest } from "@/api/handlers/legal-resolve/authorization";
import { resolveDecision } from "@/api/handlers/legal-resolve/decision";
import { resolveLawCitation } from "@/api/handlers/legal-resolve/law";

const response = {
  200: t.Any(),
  403: t.Object({ error: t.Literal("missing_scope") }),
};

const withLawRead = async (
  request: Request,
  set: { status?: number | string },
) => {
  const authorization = await authorizeLegalResolveRequest(request);
  if (authorization.status === 403) {
    set.status = 403;
    return authorization.body;
  }
  return undefined;
};

export const legalResolveRoute = new Elysia()
  .get(
    "/case/:country/decisions/resolve",
    // oxlint-disable-next-line require-safe-route-handlers/require-safe-route-handlers -- protocol bearer-scope boundary; it reads only the public corpus
    async ({ params, query }) =>
      await resolveDecision(params.country, query.identifier),
    {
      beforeHandle: async ({ request, set }) => await withLawRead(request, set),
      params: t.Object({ country: t.String({ minLength: 2, maxLength: 3 }) }),
      query: t.Object({ identifier: t.String({ maxLength: 512 }) }),
      response,
    },
  )
  .get(
    "/law/:country/citations/resolve",
    // oxlint-disable-next-line require-safe-route-handlers/require-safe-route-handlers -- protocol bearer-scope boundary; it reads only the public corpus
    async ({ params, query }) =>
      await resolveLawCitation(params.country, query),
    {
      beforeHandle: async ({ request, set }) => await withLawRead(request, set),
      params: t.Object({ country: t.String({ minLength: 2, maxLength: 3 }) }),
      query: t.Object({
        citation: t.Optional(t.String({ maxLength: 512 })),
        collection: t.Optional(t.String({ maxLength: 32 })),
        year: t.Optional(t.String({ maxLength: 4 })),
        number: t.Optional(t.String({ maxLength: 16 })),
        section: t.Optional(t.String({ maxLength: 32 })),
        asOf: t.Optional(t.String({ format: "date" })),
      }),
      response,
    },
  );
