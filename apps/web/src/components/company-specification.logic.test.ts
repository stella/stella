import { describe, expect, test } from "bun:test";

import {
  canCopyCompanySpecification,
  COMPANY_SPECIFICATION_FORMAT_MAX_LENGTH,
  companySpecificationQueryKey,
  insertCompanySpecificationToken,
} from "@/components/company-specification.logic";

describe("company specification", () => {
  test("keeps cached renderings scoped to the active organization", () => {
    const input = {
      registry: "ares" as const,
      companyId: "27082440",
      format: "[company name]",
    };

    expect(
      companySpecificationQueryKey({
        ...input,
        activeOrganizationId: "organization-a",
      }),
    ).not.toEqual(
      companySpecificationQueryKey({
        ...input,
        activeOrganizationId: "organization-b",
      }),
    );
  });

  test("does not copy a rendering from the previous debounced format", () => {
    expect(
      canCopyCompanySpecification({
        rendered: "Alza.cz a.s.",
        isPending: false,
        format: "[company name], [registry number]",
        debouncedFormat: "[company name]",
      }),
    ).toBe(false);
    expect(
      canCopyCompanySpecification({
        rendered: "Alza.cz a.s., 27082440",
        isPending: false,
        format: "[company name], [registry number]",
        debouncedFormat: "[company name], [registry number]",
      }),
    ).toBe(true);
  });

  test("refuses token insertion beyond the template limit", () => {
    const atLimit = "x".repeat(COMPANY_SPECIFICATION_FORMAT_MAX_LENGTH);

    expect(
      insertCompanySpecificationToken({
        format: atLimit,
        selectionStart: atLimit.length,
        selectionEnd: atLimit.length,
        token: "company name",
      }),
    ).toBeNull();
    expect(
      insertCompanySpecificationToken({
        format: "Company: ",
        selectionStart: 9,
        selectionEnd: 9,
        token: "company name",
      }),
    ).toEqual({ format: "Company: [company name]", caret: 23 });
  });
});
