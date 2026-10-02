import * as v from "valibot";
import { brand as mint } from "valibot";

// oxlint-disable-next-line no-provision-brand-outside-owner/no-provision-brand-outside-owner -- regression case
export const key = v.brand("ProvisionKey");
// oxlint-disable-next-line no-provision-brand-outside-owner/no-provision-brand-outside-owner -- regression case
export const ref = mint("ProvisionRef");

// expect-clean: no-provision-brand-outside-owner/no-provision-brand-outside-owner
export const other = v.brand("DocumentId");
