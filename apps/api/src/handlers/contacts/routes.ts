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
  .get("/", readContacts.handler, {
    permissions: readContacts.config.permissions,
    accountAccess: readContacts.config.accountAccess,
    query: readContacts.config.query,
  })
  .get("/sanctions/matches", listSanctionsMatches.handler, {
    permissions: listSanctionsMatches.config.permissions,
    accountAccess: listSanctionsMatches.config.accountAccess,
    query: listSanctionsMatches.config.query,
  })
  .get("/sanctions/events", listSanctionsEvents.handler, {
    permissions: listSanctionsEvents.config.permissions,
    accountAccess: listSanctionsEvents.config.accountAccess,
    query: listSanctionsEvents.config.query,
  })
  .get("/search", searchContacts.handler, {
    permissions: searchContacts.config.permissions,
    accountAccess: searchContacts.config.accountAccess,
    query: searchContacts.config.query,
  })
  .get("/business-registries", businessRegistriesLookup.handler, {
    permissions: businessRegistriesLookup.config.permissions,
    accountAccess: businessRegistriesLookup.config.accountAccess,
    query: businessRegistriesLookup.config.query,
  })
  .post("/business-registries/checks", businessRegistriesCheck.handler, {
    body: businessRegistriesCheck.config.body,
    permissions: businessRegistriesCheck.config.permissions,
    accountAccess: businessRegistriesCheck.config.accountAccess,
  })
  .get("/export", exportContacts.handler, {
    permissions: exportContacts.config.permissions,
    accountAccess: exportContacts.config.accountAccess,
    query: exportContacts.config.query,
  })
  .post("/import/inspect", inspectContactImport.handler, {
    body: inspectContactImport.config.body,
    permissions: inspectContactImport.config.permissions,
    accountAccess: inspectContactImport.config.accountAccess,
  })
  .post("/import/preview", previewContactImport.handler, {
    body: previewContactImport.config.body,
    permissions: previewContactImport.config.permissions,
    accountAccess: previewContactImport.config.accountAccess,
  })
  .post("/import/validate", validateContactImport.handler, {
    body: validateContactImport.config.body,
    permissions: validateContactImport.config.permissions,
    accountAccess: validateContactImport.config.accountAccess,
  })
  .put("/", createContact.handler, {
    body: createContact.config.body,
    permissions: createContact.config.permissions,
    accountAccess: createContact.config.accountAccess,
  })
  .put("/import", importContacts.handler, {
    body: importContacts.config.body,
    permissions: importContacts.config.permissions,
    accountAccess: importContacts.config.accountAccess,
  })
  .post("/procuracao-upload", presignProcuracao.handler, {
    body: presignProcuracao.config.body,
    permissions: presignProcuracao.config.permissions,
    accountAccess: presignProcuracao.config.accountAccess,
  })
  .post("/extract-from-procuracao", extractProcuracao.handler, {
    body: extractProcuracao.config.body,
    permissions: extractProcuracao.config.permissions,
    accountAccess: extractProcuracao.config.accountAccess,
  })
  .group(
    "/:contactId",
    {
      params: contactIdParams,
    },
    (app) =>
      app
        .get("/", readContactById.handler, {
          permissions: readContactById.config.permissions,
          accountAccess: readContactById.config.accountAccess,
        })
        .get("/sanctions", contactSanctions.handler, {
          permissions: contactSanctions.config.permissions,
          accountAccess: contactSanctions.config.accountAccess,
          query: contactSanctions.config.query,
        })
        .post("/sanctions/reviews", reviewSanctions.handler, {
          permissions: reviewSanctions.config.permissions,
          accountAccess: reviewSanctions.config.accountAccess,
          body: reviewSanctions.config.body,
        })
        .post("/sanctions/monitoring", updateSanctionsMonitoring.handler, {
          permissions: updateSanctionsMonitoring.config.permissions,
          accountAccess: updateSanctionsMonitoring.config.accountAccess,
          body: updateSanctionsMonitoring.config.body,
        })
        .post("/", updateContactById.handler, {
          body: updateContactById.config.body,
          permissions: updateContactById.config.permissions,
          accountAccess: updateContactById.config.accountAccess,
        })
        .delete("/", deleteContactById.handler, {
          permissions: deleteContactById.config.permissions,
          accountAccess: deleteContactById.config.accountAccess,
        }),
  );
