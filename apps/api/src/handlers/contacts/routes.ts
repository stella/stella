import Elysia from "elysia";

import businessRegistriesCheck from "@/api/handlers/contacts/business-registries/check";
import businessRegistriesLookup from "@/api/handlers/contacts/business-registries/lookup";
import createContact from "@/api/handlers/contacts/create";
import deleteContactById from "@/api/handlers/contacts/delete";
import exportContacts from "@/api/handlers/contacts/export";
import extractProcuracao from "@/api/handlers/contacts/extract-procuracao";
import readContactById from "@/api/handlers/contacts/get";
import importContacts from "@/api/handlers/contacts/import";
import inspectContactImport from "@/api/handlers/contacts/import-inspect";
import previewContactImport from "@/api/handlers/contacts/import-preview";
import validateContactImport from "@/api/handlers/contacts/import-validate";
import readContacts from "@/api/handlers/contacts/list";
import presignProcuracao from "@/api/handlers/contacts/presign-procuracao";
import listSanctionsEvents from "@/api/handlers/contacts/sanctions/events/list";
import contactSanctions from "@/api/handlers/contacts/sanctions/get";
import listSanctionsMatches from "@/api/handlers/contacts/sanctions/matches/list";
import updateSanctionsMonitoring from "@/api/handlers/contacts/sanctions/monitoring/update";
import reviewSanctions from "@/api/handlers/contacts/sanctions/reviews/update";
import searchContacts from "@/api/handlers/contacts/search";
import updateContactById from "@/api/handlers/contacts/update";
import { authMacro, permissionMacro } from "@/api/lib/auth";

const contactIdParams = readContactById.config.params;

export const contactsRoute = new Elysia({ prefix: "/contacts" })
  .use(authMacro)
  .use(permissionMacro)
  .guard({
    validateAuth: true,
  })
  .get(
    "/",
    {
      permissions: readContacts.config.permissions,
      query: readContacts.config.query,
    },
    readContacts.handler,
  )
  .get(
    "/sanctions/matches",
    {
      permissions: listSanctionsMatches.config.permissions,
      query: listSanctionsMatches.config.query,
    },
    listSanctionsMatches.handler,
  )
  .get(
    "/sanctions/events",
    {
      permissions: listSanctionsEvents.config.permissions,
      query: listSanctionsEvents.config.query,
    },
    listSanctionsEvents.handler,
  )
  .get(
    "/search",
    {
      permissions: searchContacts.config.permissions,
      query: searchContacts.config.query,
    },
    searchContacts.handler,
  )
  .get(
    "/business-registries",
    {
      permissions: businessRegistriesLookup.config.permissions,
      query: businessRegistriesLookup.config.query,
    },
    businessRegistriesLookup.handler,
  )
  .post(
    "/business-registries/checks",
    {
      body: businessRegistriesCheck.config.body,
      permissions: businessRegistriesCheck.config.permissions,
    },
    businessRegistriesCheck.handler,
  )
  .get(
    "/export",
    {
      permissions: exportContacts.config.permissions,
      query: exportContacts.config.query,
    },
    exportContacts.handler,
  )
  .post(
    "/import/inspect",
    {
      body: inspectContactImport.config.body,
      permissions: inspectContactImport.config.permissions,
    },
    inspectContactImport.handler,
  )
  .post(
    "/import/preview",
    {
      body: previewContactImport.config.body,
      permissions: previewContactImport.config.permissions,
    },
    previewContactImport.handler,
  )
  .post(
    "/import/validate",
    {
      body: validateContactImport.config.body,
      permissions: validateContactImport.config.permissions,
    },
    validateContactImport.handler,
  )
  .put(
    "/",
    {
      body: createContact.config.body,
      permissions: createContact.config.permissions,
    },
    createContact.handler,
  )
  .put(
    "/import",
    {
      body: importContacts.config.body,
      permissions: importContacts.config.permissions,
    },
    importContacts.handler,
  )
  .post(
    "/procuracao-upload",
    {
      body: presignProcuracao.config.body,
      permissions: presignProcuracao.config.permissions,
    },
    presignProcuracao.handler,
  )
  .post(
    "/extract-from-procuracao",
    {
      body: extractProcuracao.config.body,
      permissions: extractProcuracao.config.permissions,
    },
    extractProcuracao.handler,
  )
  .group(
    "/:contactId",
    {
      params: contactIdParams,
    },
    (app) =>
      app
        .get(
          "/",
          {
            permissions: readContactById.config.permissions,
          },
          readContactById.handler,
        )
        .get(
          "/sanctions",
          {
            permissions: contactSanctions.config.permissions,
            query: contactSanctions.config.query,
          },
          contactSanctions.handler,
        )
        .post(
          "/sanctions/reviews",
          {
            permissions: reviewSanctions.config.permissions,
            body: reviewSanctions.config.body,
          },
          reviewSanctions.handler,
        )
        .post(
          "/sanctions/monitoring",
          {
            permissions: updateSanctionsMonitoring.config.permissions,
            body: updateSanctionsMonitoring.config.body,
          },
          updateSanctionsMonitoring.handler,
        )
        .post(
          "/",
          {
            body: updateContactById.config.body,
            permissions: updateContactById.config.permissions,
          },
          updateContactById.handler,
        )
        .delete(
          "/",
          {
            permissions: deleteContactById.config.permissions,
          },
          deleteContactById.handler,
        ),
  );
