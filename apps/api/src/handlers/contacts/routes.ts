import Elysia, { t } from "elysia";

import {
  createContactBodySchema,
  createContactHandler,
} from "@/api/handlers/contacts/create";
import { deleteContactByIdHandler } from "@/api/handlers/contacts/delete-by-id";
import { readContactsHandler } from "@/api/handlers/contacts/read";
import { readContactByIdHandler } from "@/api/handlers/contacts/read-by-id";
import { searchContactsHandler } from "@/api/handlers/contacts/search";
import {
  updateContactBodySchema,
  updateContactByIdHandler,
} from "@/api/handlers/contacts/update-by-id";
import { authMacro, permissionMacro } from "@/api/lib/auth";
import { tNanoid } from "@/api/lib/custom-schema";

const contactIdParams = t.Object({ contactId: tNanoid });

export const contactsRoute = new Elysia({ prefix: "/contacts" })
  .use(authMacro)
  .use(permissionMacro)
  .guard({
    validateAuth: true,
  })
  .get(
    "/",
    (ctx) =>
      readContactsHandler({
        organizationId: ctx.session.activeOrganizationId,
        limit: ctx.query.limit,
        cursor: ctx.query.cursor,
        type: ctx.query.type,
        q: ctx.query.q,
      }),
    {
      query: t.Object({
        limit: t.Optional(t.Number({ minimum: 1, maximum: 100 })),
        cursor: t.Optional(t.String()),
        type: t.Optional(
          t.Union([t.Literal("person"), t.Literal("organization")]),
        ),
        q: t.Optional(t.String()),
      }),
    },
  )
  .get(
    "/search",
    (ctx) =>
      searchContactsHandler({
        organizationId: ctx.session.activeOrganizationId,
        q: ctx.query.q,
        type: ctx.query.type,
      }),
    {
      query: t.Object({
        q: t.String({ minLength: 1 }),
        type: t.Optional(
          t.Union([t.Literal("person"), t.Literal("organization")]),
        ),
      }),
    },
  )
  .put(
    "/",
    (ctx) =>
      createContactHandler({
        organizationId: ctx.session.activeOrganizationId,
        userId: ctx.user.id,
        body: ctx.body,
      }),
    {
      permissions: { contact: ["create"] },
      body: createContactBodySchema,
    },
  )
  .group(
    "/:contactId",
    {
      params: contactIdParams,
    },
    (app) =>
      app
        .get("/", (ctx) =>
          readContactByIdHandler({
            organizationId: ctx.session.activeOrganizationId,
            contactId: ctx.params.contactId,
          }),
        )
        .post(
          "/",
          (ctx) =>
            updateContactByIdHandler({
              organizationId: ctx.session.activeOrganizationId,
              contactId: ctx.params.contactId,
              body: ctx.body,
            }),
          {
            permissions: { contact: ["update"] },
            body: updateContactBodySchema,
          },
        )
        .delete(
          "/",
          (ctx) =>
            deleteContactByIdHandler({
              organizationId: ctx.session.activeOrganizationId,
              contactId: ctx.params.contactId,
            }),
          {
            permissions: { contact: ["delete"] },
          },
        ),
  );
