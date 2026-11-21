import type { ParsedList, SanctionsEntry } from "../entry";

const tag = (index: number): string => {
  let rest = index;
  let letters = "";
  do {
    letters = String.fromCodePoint(97 + (rest % 26)) + letters;
    rest = Math.floor(rest / 26);
  } while (rest > 0);
  return letters;
};

/** Publisher-shaped, generated records; unique letters exercise vocabulary growth. */
export const compactLists = (counts = [20_000, 10_628, 10_000]): ParsedList[] =>
  (
    [
      { source: "us-sdn", issuer: "US", aliasCount: 3 },
      { source: "eu", issuer: "EU", aliasCount: 5 },
      { source: "uk", issuer: "GB", aliasCount: 5 },
    ] as const
  ).map(({ source, issuer, aliasCount }, listIndex) => ({
    version: { source, publishedAt: "2026-09-01", fileId: null },
    entries: Array.from(
      { length: counts.at(listIndex) ?? 0 },
      (_, index): SanctionsEntry => {
        const suffix = tag(index + listIndex * 100_000);
        return {
          source,
          issuer,
          sourceId: `${source}-${index}`,
          referenceNumber: `REF-${index}`,
          entityType: index % 5 === 0 ? "organisation" : "person",
          names: Array.from({ length: aliasCount }, (_name, alias) => ({
            name: `${alias === 0 ? "Given" : "Alias"}${tag(alias)}${suffix} ${alias % 2 === 0 ? "Mohammed" : "Sergey"} Middle${suffix} Family${suffix}${tag(alias)}`,
            quality: alias === 2 ? "weak" : "strong",
          })),
          birthDates: [
            {
              precision: "day",
              year: 1940 + (index % 70),
              month: 12,
              day: 10,
              circa: false,
            },
          ],
          nationalities: [{ code: "ES", name: "Spain" }],
          identifiers: [
            {
              kind: "passport",
              status: "listed",
              label: "Passport",
              number: `P${listIndex}${100_000 + index}`,
              country: { code: "ES", name: "Spain" },
            },
          ],
          addresses: [
            {
              street: `${index} Main Street`,
              city: "Madrid",
              region: null,
              postalCode: "28001",
              country: { code: "ES", name: "Spain" },
            },
          ],
          programme: `PROGRAM-${index % 40}`,
          legalBasis: `Regulation ${index % 100}`,
          listedOn: "2026-09-01",
          sourceUrl: `https://lists.example/${source}`,
        };
      },
    ),
  }));
