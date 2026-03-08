import cors from "@elysiajs/cors";
import { Elysia } from "elysia";
import { rateLimit } from "elysia-rate-limit";

import { env } from "@/api/env";
import { analyticsRoute } from "@/api/handlers/analytics/routes";
import { billingCodesRoute } from "@/api/handlers/billing-codes/routes";
import { caseLawRoute } from "@/api/handlers/case-law/routes";
import { chatRoute } from "@/api/handlers/chat/routes";
import {
  clauseCategoriesRoute,
  clausesRoute,
} from "@/api/handlers/clauses/routes";
import { contactsRoute } from "@/api/handlers/contacts/routes";
import { devRoute } from "@/api/handlers/dev/routes";
import { entitiesRoute } from "@/api/handlers/entities/routes";
import { expensesRoute } from "@/api/handlers/expenses/routes";
import { fieldsRoute } from "@/api/handlers/fields/routes";
import { filesRoute } from "@/api/handlers/files/routes";
import { invoicesRoute } from "@/api/handlers/invoices/routes";
import { organizationSettingsRoute } from "@/api/handlers/organization-settings/routes";
import { propertiesRoute } from "@/api/handlers/properties/routes";
import { ratesRoute } from "@/api/handlers/rates/routes";
import { registry } from "@/api/handlers/registry";
import { searchRoute } from "@/api/handlers/search/routes";
import { templateAnalyticsRoute } from "@/api/handlers/template-analytics/routes";
import {
  templateCategoriesRoute,
  templatesRoute,
} from "@/api/handlers/templates/routes";
import { timeEntriesRoute } from "@/api/handlers/time-entries/routes";
import { viewsRoute } from "@/api/handlers/views/routes";
import { workspacesRoute } from "@/api/handlers/workspaces/routes";
import { auth } from "@/api/lib/auth";
import { API_RATE_LIMITS } from "@/api/lib/limits";
import { captureError, getPostHog } from "@/api/lib/posthog";
import { RedisRateLimitContext, scopedGenerator } from "@/api/lib/rate-limit";
import { setSecurityHeaders } from "@/api/lib/security-headers";

const rivetApp = new Elysia()
  .use(
    rateLimit({
      scoping: "scoped",
      duration: API_RATE_LIMITS.rivet.duration,
      max: API_RATE_LIMITS.rivet.max,
      generator: scopedGenerator("rivet"),
      context: new RedisRateLimitContext(),
    }),
  )
  .all("/api/rivet/*", (c) => registry.handler(c.request));

const api = new Elysia()
  .onRequest((ctx) => setSecurityHeaders(ctx.set))
  .use(rivetApp)
  .use(
    cors({
      origin: env.FRONTEND_URL,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      credentials: true,
      allowedHeaders: ["Content-Type", "Authorization"],
    }),
  )
  .onError(({ error, set }) => {
    // biome-ignore lint/performance/noDelete: headers value type is string | number
    delete set.headers["X-Powered-By"];
    captureError(error);
  })
  .onAfterHandle(async ({ set }) => {
    // biome-ignore lint/performance/noDelete: headers value type is string | number; delete is the correct way to remove a key
    delete set.headers["X-Powered-By"];

    const posthog = getPostHog();

    await posthog.flush().catch((error) => {
      // biome-ignore lint/suspicious/noConsole: log error
      console.error("Error flushing posthog", error);
    });
  })
  .mount(auth.handler)
  .group("/v1", (app) =>
    app

      .use(
        rateLimit({
          scoping: "scoped",
          duration: API_RATE_LIMITS.api.duration,
          max: API_RATE_LIMITS.api.max,
          generator: scopedGenerator("api"),
          context: new RedisRateLimitContext(),
        }),
      )
      .use(workspacesRoute)
      .use(propertiesRoute)
      .use(filesRoute)
      .use(entitiesRoute)
      .use(fieldsRoute)
      .use(viewsRoute)
      .use(templatesRoute)
      .use(templateCategoriesRoute)
      .use(timeEntriesRoute)
      .use(billingCodesRoute)
      .use(ratesRoute)
      .use(expensesRoute)
      .use(invoicesRoute)
      .use(organizationSettingsRoute)
      .use(clauseCategoriesRoute)
      .use(clausesRoute)
      .use(contactsRoute)
      .use(searchRoute)
      .use(analyticsRoute)
      .use(templateAnalyticsRoute)
      .use(caseLawRoute)
      .use(chatRoute)
      .use(devRoute),
  );

export default api;
