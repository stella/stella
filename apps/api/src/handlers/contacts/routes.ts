import Elysia from "elysia";

import aresLookup from "@/api/handlers/contacts/ares-lookup";
import createContact from "@/api/handlers/contacts/create";
import deleteContactById from "@/api/handlers/contacts/delete-by-id";
import readContacts from "@/api/handlers/contacts/read";
import readContactById from "@/api/handlers/contacts/read-by-id";
import searchContacts from "@/api/handlers/contacts/search";
import updateContactById from "@/api/handlers/contacts/update-by-id";
import { authMacro, permissionMacro } from "@/api/lib/auth";

const contactIdParams = readContactById.config.params;

export const contactsRoute = new Elysia({ prefix: "/contacts" })
  .use(authMacro)
  .use(permissionMacro)
  .guard({
    validateAuth: true,
  })
  .get("/", readContacts.handler, {
    query: readContacts.config.query,
  })
  .get("/search", searchContacts.handler, {
    query: searchContacts.config.query,
  })
  .get("/ares", aresLookup.handler, {
    query: aresLookup.config.query,
  })
  .put("/", createContact.handler, {
    body: createContact.config.body,
  })
  .group(
    "/:contactId",
    {
      params: contactIdParams,
    },
    (app) =>
      app
        .get("/", readContactById.handler)
        .post("/", updateContactById.handler, {
          body: updateContactById.config.body,
        })
        .delete("/", deleteContactById.handler),
  );
