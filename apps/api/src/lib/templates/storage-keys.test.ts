import { expect, test } from "bun:test";

import { createSafeId } from "@/api/lib/branded-types";
import {
  buildTemplateS3Key,
  buildTemplateWriteS3Key,
} from "@/api/lib/templates/storage-keys";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";

test("attempt keys are stable for retries and disjoint across writers and owners", () => {
  const organizationId = mintAuthProviderId<"organization">();
  const templateId = createSafeId<"template">();
  const writeId = createSafeId<"templateVersion">();
  const options = { organizationId, templateId, writeId };
  const key = buildTemplateWriteS3Key(options);
  expect(buildTemplateWriteS3Key(options)).toBe(key);
  expect(key).not.toBe(buildTemplateS3Key(organizationId, templateId));
  expect(key).not.toBe(`${organizationId}/templates/${templateId}/v2.docx`);
  for (const other of [
    { ...options, writeId: createSafeId<"templateVersion">() },
    { ...options, templateId: createSafeId<"template">() },
    {
      ...options,
      organizationId: mintAuthProviderId<"organization">(),
    },
  ]) {
    expect(buildTemplateWriteS3Key(other)).not.toBe(key);
  }
});
