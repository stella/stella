import { panic, Result } from "better-result";

import type { RecordValue } from "@stll/api-contract/record-schema";

import { runRegisterEntityCheck } from "@/api/lib/business-registries/entity-checks";
import type {
  DataSourceCallContext,
  DataSourceTool,
} from "@/api/lib/data-sources/contract";
import {
  DataSourceUnavailableError,
  textInput,
} from "@/api/lib/data-sources/contract";
import { checkCzCompanyIdInput } from "@/api/lib/data-sources/tools/cz-company-id";

const CZ_ISIR_PROCEEDINGS_TOOL_ID = "cz.isir.proceedings";

const ISIR_PUBLIC_URL = "https://isir.justice.cz";

type RegisterCheck = typeof runRegisterEntityCheck;

/**
 * Every insolvency proceeding the Czech insolvency register (ISIR) records
 * against a company, pending or ended. The list is the answer: no proceeding
 * is a fact too, not a missing record.
 */
export const createCzIsirProceedingsTool = ({
  check = runRegisterEntityCheck,
}: { check?: RegisterCheck } = {}): DataSourceTool => ({
  id: CZ_ISIR_PROCEEDINGS_TOOL_ID,
  description:
    "The insolvency proceedings the Czech insolvency register (ISIR) records " +
    "against a company, looked up by its company ID (IČO).",
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
      cardinality: "many",
      fields: [
        {
          key: "fileNumber",
          label: "File number",
          type: "text",
          nullable: false,
        },
        { key: "court", label: "Court", type: "text", nullable: true },
        // `ongoing`, `ended`, or `unverified` when the register could not
        // confirm whether the proceeding is still pending.
        { key: "phase", label: "Phase", type: "text", nullable: false },
        { key: "state", label: "Register state", type: "text", nullable: true },
        {
          key: "declaredOn",
          label: "Insolvency declared",
          type: "date",
          nullable: true,
        },
        {
          key: "endedOn",
          label: "Insolvency ended",
          type: "date",
          nullable: true,
        },
        { key: "url", label: "Register entry", type: "url", nullable: true },
      ],
    },
    version: 1,
  },
  match: "exact",
  // The register's public copy is synchronised hourly.
  cacheTtl: { hours: 1 },
  call: async (input, { observer, permit, signal }: DataSourceCallContext) => {
    const checked = await check({
      check: "cz-insolvency",
      subject: {
        type: "company-id",
        value: textInput(input, "companyId"),
        country: "CZ",
      },
      observer,
      permit,
      signal,
    });
    if (checked.isErr()) {
      return Result.err(
        new DataSourceUnavailableError({
          message: checked.error.message,
          toolId: CZ_ISIR_PROCEEDINGS_TOOL_ID,
          reason: "source-error",
          cause: checked.error,
        }),
      );
    }
    const outcome = checked.value;
    if (outcome.kind !== "cz-insolvency") {
      return panic("An insolvency check answered another check");
    }
    const asOf =
      outcome.status === "clear" || outcome.status === "found"
        ? (outcome.sourceDataAsOf ?? undefined)
        : undefined;
    const answered = (records: RecordValue[]) =>
      Result.ok({
        type: "records" as const,
        records,
        url: ISIR_PUBLIC_URL,
        ...(asOf === undefined ? {} : { sourceDataAsOf: asOf }),
      });
    switch (outcome.status) {
      case "clear":
        return answered([]);
      case "found":
        // The register returns at most a page of findings. A partial list
        // would make every count and "any ongoing" read wrong without a sign.
        if (outcome.totalMatches > outcome.findings.length) {
          return Result.err(
            new DataSourceUnavailableError({
              message: `ISIR holds ${outcome.totalMatches} proceedings and returned ${outcome.findings.length}`,
              toolId: CZ_ISIR_PROCEEDINGS_TOOL_ID,
              reason: "source-error",
            }),
          );
        }
        return answered(
          outcome.findings.map((finding) => ({
            fileNumber: finding.fileNumber,
            court: finding.court,
            phase: finding.phase,
            state: finding.stateCode,
            declaredOn: finding.insolvencyDeclaredOn,
            endedOn: finding.insolvencyEndedOn,
            url: finding.url,
          })),
        );
      case "not-registered":
      case "not-covered":
        return Result.ok({ type: "not-found", url: ISIR_PUBLIC_URL });
      case "unavailable":
        return Result.err(
          new DataSourceUnavailableError({
            message: "ISIR did not answer the check",
            toolId: CZ_ISIR_PROCEEDINGS_TOOL_ID,
            reason: outcome.reason === "timeout" ? "timeout" : "source-error",
          }),
        );
      default:
        outcome satisfies never;
        return panic("Unknown insolvency check status");
    }
  },
});
