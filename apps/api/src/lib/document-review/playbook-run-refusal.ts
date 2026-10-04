import { panic } from "better-result";

import { FILE_PROPERTY_TYPE_IMMUTABLE_CODE } from "@stll/api-contract/property-policy";

import type { OpenPlaybookRunResult } from "@/api/lib/document-review/open-playbook-run";

export const PLAYBOOK_RUN_FAILURE_CODE = {
  PROPERTIES_LIMIT: "properties_limit_reached",
  SCOPE_UNRESOLVED: "playbook_scope_unresolved",
  FILE_PROPERTY_TYPE_IMMUTABLE: FILE_PROPERTY_TYPE_IMMUTABLE_CODE,
} as const;

type PlaybookRunFailure =
  | Extract<OpenPlaybookRunResult, { ok: false }>
  | { ok: false; status: 404; message: string };

export const playbookRunFailureDetails = (failure: PlaybookRunFailure) => {
  if (!("code" in failure)) {
    return { status: failure.status, message: failure.message };
  }
  switch (failure.code) {
    case PLAYBOOK_RUN_FAILURE_CODE.PROPERTIES_LIMIT:
    case PLAYBOOK_RUN_FAILURE_CODE.SCOPE_UNRESOLVED:
    case PLAYBOOK_RUN_FAILURE_CODE.FILE_PROPERTY_TYPE_IMMUTABLE:
      return {
        status: failure.status,
        message: failure.message,
        code: failure.code,
        ...("hint" in failure ? { hint: failure.hint } : {}),
        ...("retryable" in failure ? { retryable: failure.retryable } : {}),
      };
    default: {
      failure satisfies never;
      return panic("Unhandled playbook refusal", failure);
    }
  }
};
