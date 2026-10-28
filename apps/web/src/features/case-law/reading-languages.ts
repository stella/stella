import { useQuery } from "@tanstack/react-query";
import { panic } from "better-result";

import { caseLawReadingLanguages } from "@stll/api-contract/case-law-reading-languages";

import { getMessageLocale } from "@/i18n/i18n-store";
import { useMessageLocale } from "@/i18n/message-locale";
import { useMaybeAuthenticatedUser } from "@/lib/authenticated-user-context";
import { queryView } from "@/lib/query-view.logic";
import { optionalOrganizationSettingsOptions } from "@/queries/organization-settings";

type PracticeJurisdictionEntry = { countryCode: string; isPrimary: boolean };

/** The primary practice jurisdiction first, the others in the order stored. */
const practiceCountriesOf = (
  jurisdictions: readonly PracticeJurisdictionEntry[],
): string[] =>
  jurisdictions
    .toSorted((left, right) => Number(right.isPrimary) - Number(left.isPrimary))
    .map(({ countryCode }) => countryCode);

const NO_JURISDICTIONS: readonly PracticeJurisdictionEntry[] = [];

/**
 * The reading languages a caller outside React knows: the UI language, then
 * French. A route loader reads with these; the page that renders the rows
 * asks again with the reader's practice jurisdictions once it has them.
 */
export const defaultCaseLawReadingLanguages = (): readonly string[] =>
  caseLawReadingLanguages({ uiLocale: getMessageLocale() });

/**
 * The reader's languages, most preferred first: the UI language, then the
 * languages of their organization's practice jurisdictions, then French. A
 * reader without an account, or whose settings have not arrived, has the UI
 * language and French. Every surface that shows one version of a
 * multilingual decision orders the versions by this.
 */
export const useCaseLawReadingLanguages = (): readonly string[] => {
  const uiLocale = useMessageLocale();
  const user = useMaybeAuthenticatedUser();
  const settingsView = queryView(
    useQuery({
      ...optionalOrganizationSettingsOptions({
        organizationId: user?.activeOrganizationId ?? null,
        userId: user?.id ?? "",
      }),
      retry: false,
      select: (settings) => settings.practiceJurisdictions,
    }),
  );
  // Settings that are loading, missing or failed add no language: the UI
  // language and French still order every version, so nothing waits on them
  // and nothing breaks without them.
  let jurisdictions: readonly PracticeJurisdictionEntry[];
  switch (settingsView.type) {
    case "items":
      jurisdictions = settingsView.items;
      break;
    case "pending":
    case "empty":
    case "error":
      jurisdictions = NO_JURISDICTIONS;
      break;
    default:
      settingsView satisfies never;
      return panic("Unhandled organization settings query state");
  }
  return caseLawReadingLanguages({
    uiLocale,
    practiceCountries: practiceCountriesOf(jurisdictions),
  });
};
