import { Result } from "better-result";

import type { RecordValue } from "@stll/api-contract/record-schema";

import { BUSINESS_REGISTRY_DISPATCH } from "@/api/lib/business-registries/dispatch";
import type {
  DataSourceCallContext,
  DataSourceTool,
} from "@/api/lib/data-sources/contract";
import {
  DataSourceUnavailableError,
  textInput,
} from "@/api/lib/data-sources/contract";
import { checkCzCompanyIdInput } from "@/api/lib/data-sources/tools/cz-company-id";

const CZ_ARES_LOOKUP_TOOL_ID = "cz.ares.lookup";

const ARES_PUBLIC_URL = "https://ares.gov.cz/ekonomicke-subjekty";

type AresLookup = (typeof BUSINESS_REGISTRY_DISPATCH)["ares"]["lookup"];

/** One Czech company from the ARES register, by its company ID. */
export const createCzAresLookupTool = ({
  lookup = BUSINESS_REGISTRY_DISPATCH.ares.lookup,
}: { lookup?: AresLookup } = {}): DataSourceTool => ({
  id: CZ_ARES_LOOKUP_TOOL_ID,
  description:
    "The Czech business register entry (ARES) of a company or sole trader, " +
    "looked up by its company ID (IČO).",
  input: {
    cardinality: "one",
    fields: [
      {
        key: "companyId",
        label: "Company ID (IČO)",
        type: "text",
        nullable: false,
        description:
          "The party's Czech company ID (IČO) exactly as the document states it.",
      },
    ],
  },
  checkInput: (input) => checkCzCompanyIdInput(input, "companyId"),
  output: {
    schema: {
      cardinality: "one",
      fields: [
        {
          key: "companyId",
          label: "Company ID",
          type: "text",
          nullable: false,
        },
        { key: "name", label: "Name", type: "text", nullable: false },
        { key: "legalForm", label: "Legal form", type: "text", nullable: true },
        {
          key: "status",
          label: "Register status",
          type: "text",
          nullable: true,
        },
        {
          key: "address",
          label: "Registered address",
          type: "text",
          nullable: true,
        },
        {
          key: "established",
          label: "Established",
          type: "date",
          nullable: true,
        },
        {
          key: "registryUrl",
          label: "Register entry",
          type: "url",
          nullable: false,
        },
      ],
    },
    version: 1,
  },
  match: "exact",
  cacheTtl: { hours: 24 },
  call: async (input, { observer, permit }: DataSourceCallContext) => {
    const companyId = textInput(input, "companyId");
    const looked = await Result.tryPromise({
      try: async () => await lookup(companyId, { observer, permit }),
      catch: (cause) =>
        new DataSourceUnavailableError({
          message: "ARES did not answer the lookup",
          toolId: CZ_ARES_LOOKUP_TOOL_ID,
          reason: "network",
          cause,
        }),
    });
    if (looked.isErr()) {
      return Result.err(looked.error);
    }
    const hit = looked.value;
    const url = `${ARES_PUBLIC_URL}?ico=${companyId}`;
    if (hit === null) {
      return Result.ok({ type: "not-found", url });
    }
    const company =
      hit.details?.registry === "ares" ? hit.details.company : null;
    const record: RecordValue = {
      companyId: hit.id,
      name: hit.name,
      legalForm: hit.legalForm,
      status: company?.status ?? null,
      address: hit.address?.textAddress ?? null,
      established: company?.dateEstablished ?? null,
      registryUrl: hit.registryUrl,
    };
    return Result.ok({
      type: "records",
      records: [record],
      url: hit.registryUrl,
    });
  },
});
