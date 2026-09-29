import Elysia from "elysia";

import archiveVatRate from "@/api/handlers/vat-rates/archive";
import createVatRate from "@/api/handlers/vat-rates/create";
import listVatRates from "@/api/handlers/vat-rates/list";
import updateVatRate from "@/api/handlers/vat-rates/update";
import { authMacro, permissionMacro } from "@/api/lib/auth";

export const vatRateRoute = new Elysia({ prefix: "/vat-rates" })
  .use(authMacro)
  .use(permissionMacro)
  .guard({ validateAuth: true })
  .get("/", listVatRates.handler, {
    permissions: listVatRates.config.permissions,
    query: listVatRates.config.query,
  })
  .post("/", createVatRate.handler, {
    permissions: createVatRate.config.permissions,
    body: createVatRate.config.body,
  })
  .patch("/:vatRateId", updateVatRate.handler, {
    permissions: updateVatRate.config.permissions,
    params: updateVatRate.config.params,
    body: updateVatRate.config.body,
  })
  .post("/:vatRateId/archive", archiveVatRate.handler, {
    permissions: archiveVatRate.config.permissions,
    params: archiveVatRate.config.params,
  });
