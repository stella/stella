import type { LookupRegistryOption } from "@/components/templates/registry-options";

export const COMPANY_SPECIFICATION_FORMAT_MAX_LENGTH = 2000;

export const companySpecificationRegistryKey = ({
  activeOrganizationId,
  registry,
}: {
  activeOrganizationId: string;
  registry: LookupRegistryOption["slug"];
}) => ["company-specification", activeOrganizationId, registry] as const;

export const companySpecificationQueryKey = ({
  activeOrganizationId,
  registry,
  companyId,
  format,
}: {
  activeOrganizationId: string;
  registry: LookupRegistryOption["slug"];
  companyId: string;
  format: string;
}) =>
  [
    ...companySpecificationRegistryKey({ activeOrganizationId, registry }),
    companyId,
    format,
  ] as const;

export const insertCompanySpecificationToken = ({
  format,
  selectionStart,
  selectionEnd,
  token,
}: {
  format: string;
  selectionStart: number;
  selectionEnd: number;
  token: string;
}): { format: string; caret: number } | null => {
  const inserted = `[${token}]`;
  const next =
    format.slice(0, selectionStart) + inserted + format.slice(selectionEnd);
  if (next.length > COMPANY_SPECIFICATION_FORMAT_MAX_LENGTH) {
    return null;
  }
  return { format: next, caret: selectionStart + inserted.length };
};

export const canCopyCompanySpecification = ({
  rendered,
  isPending,
  format,
  debouncedFormat,
}: {
  rendered: string | undefined;
  isPending: boolean;
  format: string;
  debouncedFormat: string;
}): boolean =>
  rendered !== undefined &&
  rendered.trim() !== "" &&
  !isPending &&
  format === debouncedFormat;
