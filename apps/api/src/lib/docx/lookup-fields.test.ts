import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import { parseResRecord } from "@stll/business-registries/ares";
import { ARES_DEFAULT_FORMAT } from "@stll/business-registries/ares/default-format";
import {
  BUSINESS_REGISTRY_FORMAT_CAPABILITIES,
  PREVIOUS_DEFAULT_FORMATS,
} from "@stll/business-registries/default-formats";
import type { EdgarCompany } from "@stll/business-registries/edgar";
import { KrsValidationError } from "@stll/business-registries/krs";
import type { OrsrCompany } from "@stll/business-registries/orsr";
import { filtersFromFieldConfig } from "@stll/template-conditions";

import type {
  BusinessRegistryHit,
  RegistryHandler,
} from "@/api/lib/business-registries/dispatch";
import {
  BUSINESS_REGISTRY_DISPATCH,
  BUSINESS_REGISTRY_SLUGS,
} from "@/api/lib/business-registries/dispatch";

import { discoverTemplate } from "./discover-template";
import {
  applyLookupFields,
  createDispatchLookupResolver,
  isPlausibleLookupValue,
  type LookupResolver,
  lookupValueFromRendered,
  parseLookupMarkdown,
  renderLookupHit,
  renderLookupOutput,
  renderLookupTemplate,
  resolveLookupFields,
  stripLookupMarkdown,
} from "./lookup-fields";
import { applyManifestFillSteps } from "./manifest-fill-steps";
import { fillTemplate } from "./patch-template";
import { patchXmlPart } from "./rich-patch";
import { mergeManifestWithDiscovery } from "./template-manifest";
import type { FieldMeta, TemplateData, TemplateManifest } from "./types";
import { writeFieldFilters } from "./write-field-filters";

/**
 * The document with each field's configuration authored into the marker that
 * declares it: the DOCX is the only place a template's fields are configured,
 * so a fixture naming a path the document does not carry configures nothing.
 */
const authorFieldMarkers = async (
  docx: Buffer,
  fields: readonly FieldMeta[],
): Promise<Buffer> => {
  const { buffer, written } = await writeFieldFilters(
    docx,
    fields.map((field) => ({
      path: field.path,
      filters: filtersFromFieldConfig(field),
    })),
  );
  for (const { path } of fields) {
    if (!written.has(path)) {
      throw new Error(`fixture has no {{${path}}} marker to configure`);
    }
  }
  return buffer;
};

const KRS_ADDRESS = {
  line1: "ul. Stanisława Matyi 8",
  line2: null,
  postalCode: "61-586",
  city: "Poznań",
  region: "wielkopolskie",
  country: "Polska",
  textAddress: "ul. Stanisława Matyi 8, 61-586 Poznań",
};

const KRS_HIT: BusinessRegistryHit = {
  registry: "krs",
  id: "0000123456",
  name: "Żabka Polska sp. z o.o.",
  legalForm: "spółka z ograniczoną odpowiedzialnością",
  address: KRS_ADDRESS,
  registryUrl: "https://example.invalid/krs/0000123456",
};

// An empty default template falls back to the deterministic "name, address"
// rendering of the hit.
const krsField: FieldMeta = {
  path: "buyer_krs",
  lookup: { registry: "krs", formats: [{ key: "output_1", template: "" }] },
};

const hitResolver =
  (hit: BusinessRegistryHit): LookupResolver =>
  async () => ({ type: "hit", hit });

describe("isPlausibleLookupValue", () => {
  test("accepts a 10-digit KRS number, whitespace-tolerant", () => {
    expect(isPlausibleLookupValue("krs", "0000123456")).toBe(true);
    expect(isPlausibleLookupValue("krs", " 0000 592 109 ")).toBe(true);
  });

  test("accepts a numeric DENUE establishment Id", () => {
    expect(isPlausibleLookupValue("denue", "6281106")).toBe(true);
    expect(isPlausibleLookupValue("denue", "DENUE-6281106")).toBe(false);
  });

  test("rejects short, long, and non-numeric inputs", () => {
    expect(isPlausibleLookupValue("krs", "123456")).toBe(false);
    expect(isPlausibleLookupValue("krs", "00001234560")).toBe(false);
    expect(isPlausibleLookupValue("krs", "KRS0123456")).toBe(false);
  });
});

describe("renderLookupHit", () => {
  test("renders a registry-specific identification reference", () => {
    expect(renderLookupHit(KRS_HIT)).toBe(
      "**Żabka Polska sp. z o.o.**, siedziba: Poznań, adres: ul. Stanisława Matyi 8, 61-586 Poznań, numer w Krajowym Rejestrze Sądowym: 0000123456",
    );
  });

  test("omits missing registry particulars without dangling labels", () => {
    expect(
      renderLookupHit({
        ...KRS_HIT,
        address: { ...KRS_ADDRESS, textAddress: null },
      }),
    ).toBe(
      "**Żabka Polska sp. z o.o.**, siedziba: Poznań, numer w Krajowym Rejestrze Sądowym: 0000123456",
    );
    expect(renderLookupHit({ ...KRS_HIT, address: null })).toBe(
      "**Żabka Polska sp. z o.o.**, numer w Krajowym Rejestrze Sądowym: 0000123456",
    );
  });

  test("renders Companies House particulars in UK contract style", () => {
    const hit = {
      registry: "companies-house",
      id: "01003142",
      name: "ROLLS-ROYCE PLC",
      legalForm: "plc",
      address: {
        line1: "Kings Place, 90 York Way",
        line2: null,
        postalCode: "N1 9FX",
        city: "London",
        region: null,
        country: "United Kingdom",
        textAddress: "Kings Place, 90 York Way, London, United Kingdom, N1 9FX",
      },
      registryUrl:
        "https://find-and-update.company-information.service.gov.uk/company/01003142",
      details: {
        registry: "companies-house",
        company: {
          companyNumber: "01003142",
          name: "ROLLS-ROYCE PLC",
          status: { type: "active" },
          statusDetail: null,
          type: "plc",
          subtype: null,
          jurisdiction: "england-wales",
          dateOfCreation: "1971-02-23",
          dateOfCessation: null,
          registeredOfficeAddress: null,
          serviceAddress: null,
          sicCodes: [],
          accounts: null,
          confirmationStatement: null,
          hasCharges: null,
          hasInsolvencyHistory: null,
          hasBeenLiquidated: null,
          previousNames: [],
          registryUrl:
            "https://find-and-update.company-information.service.gov.uk/company/01003142",
        },
      },
    } satisfies BusinessRegistryHit;

    expect(renderLookupOutput(null, hit)).toBe(
      "**ROLLS-ROYCE PLC**, public limited company registered in England and Wales (company number 01003142) whose registered office is at Kings Place, 90 York Way, London, United Kingdom, N1 9FX",
    );
  });

  test("keeps a French legal entity's SIREN distinct from a branch SIRET", () => {
    const headOffice = {
      siret: "55208131700018",
      isHeadOffice: true,
      address: {
        textAddress: "22 avenue de Wagram, 75008 Paris",
        street: "22 avenue de Wagram",
        postalCode: "75008",
        city: "Paris",
        country: "France",
      },
      activityCode: null,
      status: { type: "open" },
      createdAt: null,
      closedAt: null,
    } as const;
    const branch = {
      ...headOffice,
      siret: "55208131701234",
      isHeadOffice: false,
      address: {
        ...headOffice.address,
        textAddress: "1 rue de Lyon, 69000 Lyon",
        street: "1 rue de Lyon",
        postalCode: "69000",
        city: "Lyon",
      },
    } as const;
    const hit = {
      registry: "recherche-entreprises",
      id: branch.siret,
      name: "EXEMPLE SA",
      legalForm: "5599",
      address: {
        line1: branch.address.street,
        line2: null,
        postalCode: branch.address.postalCode,
        city: branch.address.city,
        region: null,
        country: branch.address.country,
        textAddress: branch.address.textAddress,
      },
      registryUrl: "https://example.invalid/fr/552081317",
      details: {
        registry: "recherche-entreprises",
        company: {
          siren: "552081317",
          name: "EXEMPLE SA",
          legalFormCode: "5599",
          shortName: null,
          headOffice,
          matchedEstablishment: branch,
          status: { type: "active" },
          registeredAt: null,
          ceasedAt: null,
          directors: [],
          registryUrl: "https://example.invalid/fr/552081317",
        },
      },
    } satisfies BusinessRegistryHit;

    expect(renderLookupOutput(null, hit)).toBe(
      "**EXEMPLE SA**, dont le siège social est situé 22 avenue de Wagram, 75008 Paris, numéro SIREN 552 081 317",
    );
    expect(
      renderLookupOutput("SIREN [SIREN spaced], SIRET [SIRET spaced]", hit),
    ).toBe("SIREN 552 081 317, SIRET 552 081 317 01234");
  });

  test("renders a French head-office hit without a branch SIRET", () => {
    const hit = {
      registry: "recherche-entreprises",
      id: "552081317",
      name: "EXEMPLE SA",
      legalForm: "5599",
      address: null,
      registryUrl: "https://example.invalid/fr/552081317",
      details: {
        registry: "recherche-entreprises",
        company: {
          siren: "552081317",
          name: "EXEMPLE SA",
          legalFormCode: "5599",
          shortName: null,
          headOffice: null,
          matchedEstablishment: null,
          status: { type: "active" },
          registeredAt: null,
          ceasedAt: null,
          directors: [],
          registryUrl: "https://example.invalid/fr/552081317",
        },
      },
    } satisfies BusinessRegistryHit;
    expect(
      renderLookupOutput("SIREN [SIREN spaced] SIRET [SIRET spaced]", hit),
    ).toBe("SIREN 552 081 317 SIRET");
  });

  test.each([
    ["942404110", "94-2404110"],
    // EDGAR has returned a punctuated EIN before: it is passed through, not
    // punctuated twice.
    ["94-2404110", "94-2404110"],
    [null, ""],
  ])("punctuates the EDGAR EIN %s for a US party block", (ein, dashed) => {
    const company = {
      cik: "0000320193",
      name: "Apple Inc.",
      sic: null,
      sicDescription: null,
      tickers: [],
      exchanges: [],
      ein,
      addresses: { mailing: null, business: null },
      formerNames: [],
      recentFilings: [],
      status: { type: "active" },
      registryUrl: "https://example.invalid/us/0000320193",
    } satisfies EdgarCompany;
    const hit = {
      registry: "edgar",
      id: company.cik,
      name: company.name,
      legalForm: null,
      address: null,
      registryUrl: company.registryUrl,
      details: { registry: "edgar", company },
    } satisfies BusinessRegistryHit;
    expect(renderLookupOutput("IRS No. [EIN dashed]", hit)).toBe(
      `IRS No. ${dashed}`.trim(),
    );
  });

  test("groups a Norwegian organisasjonsnummer", () => {
    const hit = {
      registry: "brreg",
      id: "923609016",
      name: "EXEMPLE AS",
      legalForm: "AS",
      address: null,
      registryUrl: "https://example.invalid/no/923609016",
    } satisfies BusinessRegistryHit;
    expect(
      renderLookupOutput("organisasjonsnummer [registry number spaced]", hit),
    ).toBe("organisasjonsnummer 923 609 016");
  });
});

describe("renderLookupOutput", () => {
  test.each([
    [
      "Městský soud v Praze",
      "B",
      "8573",
      "Praha 7",
      "**Example a.s.**, se sídlem Praha 7, IČO: 270 82 440, zapsaná v obchodním rejstříku vedeném Městským soudem v Praze pod sp. zn. B 8573",
    ],
    [
      "UNKNOWN",
      "B",
      "8573",
      "Praha 7",
      "**Example a.s.**, se sídlem Praha 7, IČO: 270 82 440",
    ],
    [null, "B", "8573", null, "**Example a.s.**, IČO: 270 82 440"],
    [
      "Městský soud v Praze",
      "",
      "8573",
      "Praha 7",
      "**Example a.s.**, se sídlem Praha 7, IČO: 270 82 440",
    ],
    [
      "Městský soud v Praze",
      "B",
      "",
      "Praha 7",
      "**Example a.s.**, se sídlem Praha 7, IČO: 270 82 440",
    ],
  ])(
    "uses the ARES default without inventing absent particulars: %s/%s/%s/%s",
    (court, section, insert, address, expected) => {
      const company = {
        ...parseResRecord({
          ico: "27082440",
          obchodniJmeno: "Example a.s.",
          pravniForma: "121",
          primarniZaznam: true,
        }),
        courtFile: court === null ? null : { court, section, insert },
      };
      const hit = {
        registry: "ares",
        id: company.ico,
        name: company.name,
        legalForm: company.legalForm,
        address:
          address === null ? null : { ...KRS_ADDRESS, textAddress: address },
        registryUrl: company.registryUrl,
        details: { registry: "ares", company },
      } satisfies BusinessRegistryHit;
      expect(renderLookupOutput(null, hit)).toBe(expected);
      expect(renderLookupOutput(ARES_DEFAULT_FORMAT, hit)).toBe(expected);
      expect(renderLookupOutput("  ", hit)).toBe(expected);
      expect(
        renderLookupOutput(
          "Custom **[company name]** ([registry number])",
          hit,
        ),
      ).toBe("Custom **Example a.s.** (27082440)");
      expect(stripLookupMarkdown(renderLookupOutput(null, hit))).toBe(
        expected.replaceAll("**", ""),
      );
    },
  );
  test.each([
    ["Městský soud v Praze", "B", "8573"],
    [null, "", ""],
  ])(
    "a saved copy of the previous ARES built-in still renders as the built-in: %s",
    (court, section, insert) => {
      const company = {
        ...parseResRecord({
          ico: "27082440",
          obchodniJmeno: "Example a.s.",
          pravniForma: "121",
          primarniZaznam: true,
        }),
        courtFile: court === null ? null : { court, section, insert },
      };
      const hit = {
        registry: "ares",
        id: company.ico,
        name: company.name,
        legalForm: company.legalForm,
        address: { ...KRS_ADDRESS, textAddress: "Praha 7" },
        registryUrl: company.registryUrl,
        details: { registry: "ares", company },
      } satisfies BusinessRegistryHit;
      expect(renderLookupOutput(PREVIOUS_DEFAULT_FORMATS.ares[0], hit)).toBe(
        renderLookupOutput(null, hit),
      );
    },
  );
  test.each(["101", "706", "205", null, "unknown"])(
    "ARES defaults do not label non-company legal forms as companies: %s",
    (legalForm) => {
      const company = {
        ...parseResRecord({
          ico: "27082440",
          obchodniJmeno: "Example",
          primarniZaznam: true,
        }),
        legalForm,
        courtFile: {
          court: "Městský soud v Praze",
          section: "L",
          insert: "123",
        },
      };
      const hit = {
        registry: "ares",
        id: company.ico,
        name: company.name,
        legalForm,
        address: null,
        registryUrl: company.registryUrl,
        details: { registry: "ares", company },
      } satisfies BusinessRegistryHit;
      expect(renderLookupOutput(null, hit)).toBe(
        "**Example**, IČO: 270 82 440",
      );
      expect(renderLookupOutput(ARES_DEFAULT_FORMAT, hit)).toBe(
        "**Example**, IČO: 270 82 440",
      );
    },
  );
  test.each([
    [
      "Městský soud v Praze",
      "Městským soudem v Praze",
      "Městského soudu v Praze",
    ],
    ["Krajský soud v Brně", "Krajským soudem v Brně", "Krajského soudu v Brně"],
    ["MSPH", "Městským soudem v Praze", "Městského soudu v Praze"],
    ["UNKNOWN", "", ""],
    [null, "", ""],
  ])(
    "renders the declined court tokens from ARES particulars: %s",
    (court, instrumental, genitive) => {
      const company = {
        ...parseResRecord({
          ico: "27082440",
          obchodniJmeno: "Alza.cz a.s.",
          primarniZaznam: true,
        }),
        courtFile:
          court === null ? null : { court, section: "B", insert: "8573" },
      };
      const hit = {
        registry: "ares",
        id: company.ico,
        name: company.name,
        legalForm: company.legalForm,
        address: null,
        registryUrl: company.registryUrl,
        details: { registry: "ares", company },
      } satisfies BusinessRegistryHit;
      expect(renderLookupOutput("Soud: [court instrumental]", hit)).toBe(
        `Soud: ${instrumental}`.trim(),
      );
      expect(renderLookupOutput("u [court genitive]", hit)).toBe(
        `u ${genitive}`.trim(),
      );
      expect(renderLookupOutput("IČO: [registry number spaced]", hit)).toBe(
        "IČO: 270 82 440",
      );
    },
  );
  test.each([
    ["Mestský súd Bratislava III", "B", "Mestského súdu Bratislava III"],
    ["Okresný súd Trenčín", "R", "Okresného súdu Trenčín"],
    // The extract omitted the name: the insert letter still resolves.
    [null, "V", "Mestského súdu Košice"],
    // Renamed by the 2023 court map — not inflected from a stale name.
    ["Okresný súd Bratislava I", "B", "Mestského súdu Bratislava III"],
    [null, "Z", ""],
  ])(
    "renders the declined ORSR court token from %s",
    (courtName, court, genitive) => {
      const company = {
        ico: "31322832",
        name: "ESET, spol. s r.o.",
        legalForm: "Spoločnosť s ručením obmedzeným",
        address: null,
        courtFile: { court, courtName, section: "Sro", insertNumber: "3586" },
        establishedAt: null,
        terminatedAt: null,
        shareCapital: null,
        shareCapitalPaid: null,
        actingClause: null,
        status: { type: "active" },
        statutoryBodies: [],
        stakeholders: [],
        registryUrl: "https://example.invalid/sk/31322832",
      } satisfies OrsrCompany;
      const hit = {
        registry: "orsr",
        id: company.ico,
        name: company.name,
        legalForm: company.legalForm,
        address: null,
        registryUrl: company.registryUrl,
        details: { registry: "orsr", company },
      } satisfies BusinessRegistryHit;
      expect(
        renderLookupOutput("v Obchodnom registri [court genitive]", hit),
      ).toBe(`v Obchodnom registri ${genitive}`.trim());
      expect(renderLookupOutput("IČO: [registry number spaced]", hit)).toBe(
        "IČO: 31 322 832",
      );
    },
  );
  test("groups a Slovak IČO on a search row carrying no extract", () => {
    const hit = {
      registry: "orsr",
      id: "00151653",
      name: "Slovenská sporiteľňa, a.s.",
      legalForm: null,
      address: null,
      registryUrl: "https://example.invalid/sk/00151653",
    } satisfies BusinessRegistryHit;
    expect(renderLookupOutput("IČO: [registry number spaced]", hit)).toBe(
      "IČO: 00 151 653",
    );
    expect(
      renderLookupOutput("v Obchodnom registri [court genitive]", hit),
    ).toBe("v Obchodnom registri");
  });
  test("renders ARES output tokens as readable company particulars", () => {
    const company = {
      ...parseResRecord({
        ico: "12345678",
        obchodniJmeno: "Example s.r.o.",
        pravniForma: "112",
        datumZapisu: "2020-09-05",
        primarniZaznam: true,
      }),
      shareCapital: "50 000,- Kč",
      actingClause:
        "Jednatel jedná samostatně.\n\nPodepisuje se za společnost.",
      statutoryBodies: [
        {
          organName: "Statutární orgán",
          members: [
            {
              name: "Jan Novák",
              role: "jednatel",
              address: "Dlouhá 1, Praha",
              since: "2020-09-05",
            },
          ],
        },
      ],
    };
    const hit = {
      registry: "ares",
      id: company.ico,
      name: company.name,
      legalForm: company.legalForm,
      address: null,
      registryUrl: company.registryUrl,
      details: { registry: "ares", company },
    } satisfies BusinessRegistryHit;
    expect(
      renderLookupOutput(
        "[legal form]\n[share capital]\n[registered on]\n[acting clause]\n[statutory bodies]",
        hit,
      ),
    ).toBe(
      "Společnost s ručením omezeným\n50 000,- Kč\n5. 9. 2020\nJednatel jedná samostatně.\n\nPodepisuje se za společnost.\nStatutární orgán\nJan Novák, jednatel, Dlouhá 1, Praha, od 5. 9. 2020",
    );
  });
  test("renders the format template with its formatting markers intact", () => {
    expect(
      renderLookupOutput("**[company name]**, seat in *[seat]*", KRS_HIT),
    ).toBe("**Żabka Polska sp. z o.o.**, seat in *Poznań*");
  });

  test("uses the KRS registered seat instead of the postal-address city", () => {
    const hit = {
      ...KRS_HIT,
      details: {
        registry: "krs",
        entity: {
          krsNumber: KRS_HIT.id,
          register: "RejP",
          name: KRS_HIT.name,
          legalForm: KRS_HIT.legalForm,
          identifiers: { nip: null, regon: null },
          shareCapital: null,
          address: null,
          registeredSeat: {
            country: "POLSKA",
            voivodeship: "MAZOWIECKIE",
            county: "WARSZAWA",
            commune: "WARSZAWA",
            locality: "Warszawa",
          },
          email: null,
          website: null,
          status: { type: "active" },
          registeredAt: null,
          lastEntryAt: null,
          registryUrl: KRS_HIT.registryUrl,
        },
      },
    } satisfies BusinessRegistryHit;

    expect(renderLookupOutput("seat in [seat]", hit)).toBe("seat in Warszawa");
  });

  test("uses the built-in format for null and the generic fallback for blank custom formats", () => {
    const fallback =
      "Żabka Polska sp. z o.o., ul. Stanisława Matyi 8, 61-586 Poznań";
    expect(renderLookupOutput(null, KRS_HIT)).toBe(
      "**Żabka Polska sp. z o.o.**, siedziba: Poznań, adres: ul. Stanisława Matyi 8, 61-586 Poznań, numer w Krajowym Rejestrze Sądowym: 0000123456",
    );
    expect(renderLookupOutput("  ", KRS_HIT)).toBe(fallback);
    // A template of only unknown tokens renders empty → same fallback.
    expect(renderLookupOutput("[no such token]", KRS_HIT)).toBe(fallback);
  });
});

describe("parseLookupMarkdown", () => {
  test("parses **bold** spans into bold runs", () => {
    expect(parseLookupMarkdown("**Acme** Ltd")).toEqual([
      { text: "Acme", bold: true },
      { text: " Ltd" },
    ]);
  });

  test("parses *italic* spans into italic runs", () => {
    expect(parseLookupMarkdown("seat in *Poznań*")).toEqual([
      { text: "seat in " },
      { text: "Poznań", italic: true },
    ]);
  });

  test("parses mixed bold and italic spans in one string", () => {
    expect(
      parseLookupMarkdown("**Acme**, with its seat in *Poznań*, KRS 123"),
    ).toEqual([
      { text: "Acme", bold: true },
      { text: ", with its seat in " },
      { text: "Poznań", italic: true },
      { text: ", KRS 123" },
    ]);
  });

  test("leaves unmatched and empty asterisks literal", () => {
    expect(parseLookupMarkdown("a * b")).toEqual([{ text: "a * b" }]);
    expect(parseLookupMarkdown("a ** b")).toEqual([{ text: "a ** b" }]);
    expect(parseLookupMarkdown("****")).toEqual([{ text: "****" }]);
    expect(parseLookupMarkdown("**dangling")).toEqual([{ text: "**dangling" }]);
  });

  test("keeps a stray asterisk inside a substituted value literal", () => {
    // Span content is asterisk-free and italic `*` cannot pair against a
    // `**` delimiter, so a `*` inside a company name defuses the whole span
    // instead of producing surprise italics.
    expect(parseLookupMarkdown("**A*B Corp**")).toEqual([
      { text: "**A*B Corp**" },
    ]);
  });
});

describe("stripLookupMarkdown", () => {
  test("strips formatting markers for the plain-text preview", () => {
    expect(stripLookupMarkdown("**Acme**, seat in *Poznań*")).toBe(
      "Acme, seat in Poznań",
    );
  });

  test("keeps unmatched asterisks", () => {
    expect(stripLookupMarkdown("2 * 3 = 6")).toBe("2 * 3 = 6");
  });
});

describe("lookupValueFromRendered", () => {
  test("returns the plain string when no formatting is present", () => {
    expect(lookupValueFromRendered("Acme Ltd, Poznań")).toBe(
      "Acme Ltd, Poznań",
    );
    // Unmatched asterisks stay literal, so the value stays a plain string.
    expect(lookupValueFromRendered("a * b")).toBe("a * b");
  });

  test("returns a rich patch value when formatting is present", () => {
    expect(lookupValueFromRendered("**Acme** Ltd")).toEqual({
      paragraphs: [{ runs: [{ text: "Acme", bold: true }, { text: " Ltd" }] }],
    });
  });
});

describe("resolveLookupFields", () => {
  test("passes values through when no field has a lookup", async () => {
    const values = { buyer_krs: "not even a number" };
    const result = await resolveLookupFields({
      values,
      fields: [{ path: "buyer_krs" }],
      resolve: hitResolver(KRS_HIT),
    });
    expect(result).toEqual({ ok: true, values });
  });

  test("leaves an absent or empty value for required diagnostics", async () => {
    const result = await resolveLookupFields({
      values: { buyer_krs: "  " },
      fields: [krsField],
      resolve: hitResolver(KRS_HIT),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.values["buyer_krs"]).toBe("  ");
    }
  });

  test("rejects a malformed registry number naming the field", async () => {
    const result = await resolveLookupFields({
      values: { buyer_krs: "12345" },
      fields: [krsField],
      resolve: hitResolver(KRS_HIT),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([
        {
          path: "buyer_krs",
          message: 'Field "buyer_krs": "12345" is not a valid KRS number.',
        },
      ]);
    }
  });

  test("rejects when the registry has no match, naming the field", async () => {
    const result = await resolveLookupFields({
      values: { buyer_krs: "0000123456" },
      fields: [krsField],
      resolve: async () => ({ type: "not-found" }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.at(0)?.message).toBe(
        'Field "buyer_krs": no company found in KRS for "0000123456".',
      );
    }
  });

  test("rejects on an upstream error, surfacing its message", async () => {
    const result = await resolveLookupFields({
      values: { buyer_krs: "0000123456" },
      fields: [krsField],
      resolve: async () => ({ type: "error", message: "KRS API error: 503" }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.at(0)?.message).toBe(
        'Field "buyer_krs": KRS lookup failed: KRS API error: 503',
      );
    }
  });

  test("replaces the number with the deterministic rendering", async () => {
    const result = await resolveLookupFields({
      values: { buyer_krs: "0000123456", other: "kept" },
      fields: [krsField],
      resolve: hitResolver(KRS_HIT),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.values["buyer_krs"]).toBe(
        "Żabka Polska sp. z o.o., ul. Stanisława Matyi 8, 61-586 Poznań",
      );
      expect(result.values["other"]).toBe("kept");
    }
  });

  test("replaces a nested value where resolvePath found it", async () => {
    const result = await resolveLookupFields({
      values: { buyer: { krs: "0000123456" } },
      fields: [
        {
          path: "buyer.krs",
          lookup: {
            registry: "krs",
            formats: [{ key: "output_1", template: "" }],
          },
        },
      ],
      resolve: hitResolver(KRS_HIT),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.values["buyer"]).toEqual({
        krs: "Żabka Polska sp. z o.o., ul. Stanisława Matyi 8, 61-586 Poznań",
      });
    }
  });

  test("resolves a lookup field inside a repeatable each row", async () => {
    // Inside `{% for company in companies %}` the value arrives as an array of row
    // objects, so the field path `companies.krs` resolves to undefined at the
    // top level; each row's sub-path number must be resolved and rendered in
    // place. Every format is written as a flat dotted key on the row, and the
    // first one additionally replaces the submitted number at the row path,
    // which is what the bare `{{ company.krs }}` marker renders.
    const result = await resolveLookupFields({
      values: {
        companies: [{ krs: "0000123456" }, { krs: "0000123456" }],
      },
      fields: [
        {
          path: "companies.krs",
          lookup: {
            registry: "krs",
            formats: [
              { key: "output_1", template: "[company name]" },
              { key: "full", template: "[company name], seat in [seat]" },
            ],
          },
        },
      ],
      resolve: hitResolver(KRS_HIT),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const row = {
        krs: "Żabka Polska sp. z o.o.",
        "krs.output_1": "Żabka Polska sp. z o.o.",
        "krs.full": "Żabka Polska sp. z o.o., seat in Poznań",
      };
      expect(result.values["companies"]).toEqual([row, row]);
    }
  });

  test("reports a malformed registry number inside a repeatable each row", async () => {
    const result = await resolveLookupFields({
      values: { companies: [{ krs: "12345" }] },
      fields: [
        {
          path: "companies.krs",
          lookup: {
            registry: "krs",
            formats: [{ key: "output_1", template: "" }],
          },
        },
      ],
      resolve: hitResolver(KRS_HIT),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([
        {
          path: "companies.krs",
          message: 'Field "companies.krs": "12345" is not a valid KRS number.',
        },
      ]);
    }
  });

  test("renders the template deterministically even when the field is Person + AI", async () => {
    // aiAdapt (Person + AI) changes nothing at lookup time: the author's
    // [token] template is substituted from the hit, no formatter involved.
    // Grammar adjustments happen downstream in the per-occurrence aiAdapt pass.
    const result = await resolveLookupFields({
      values: { buyer_krs: "0000123456" },
      fields: [
        {
          path: "buyer_krs",
          aiAdapt: true,
          lookup: {
            registry: "krs",
            formats: [
              { key: "output_1", template: "[company name], seat: [seat]" },
            ],
          },
        },
      ],
      resolve: hitResolver(KRS_HIT),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.values["buyer_krs"]).toBe(
        "Żabka Polska sp. z o.o., seat: Poznań",
      );
    }
  });

  test("turns **bold** / *italic* in the format into a rich patch value", async () => {
    const result = await resolveLookupFields({
      values: { buyer_krs: "0000123456" },
      fields: [
        {
          path: "buyer_krs",
          lookup: {
            registry: "krs",
            formats: [
              {
                key: "output_1",
                template: "**[company name]**, with its seat in *[seat]*",
              },
            ],
          },
        },
      ],
      resolve: hitResolver(KRS_HIT),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.values["buyer_krs"]).toEqual({
        paragraphs: [
          {
            runs: [
              { text: "Żabka Polska sp. z o.o.", bold: true },
              { text: ", with its seat in " },
              { text: "Poznań", italic: true },
            ],
          },
        ],
      });
    }
  });

  test("renders two named formats off one hit alongside the default", async () => {
    let calls = 0;
    const result = await resolveLookupFields({
      values: { company: "0000123456" },
      fields: [
        {
          path: "company",
          lookup: {
            registry: "krs",
            // The first format is the default for the bare {{company}} marker;
            // the rest are keyed {{company.<key>}}.
            formats: [
              { key: "output_1", template: "[company name]" },
              { key: "full", template: "[company name], seat in [seat]" },
              { key: "short", template: "[company name]" },
            ],
          },
        },
      ],
      resolve: async () => {
        calls += 1;
        return { type: "hit", hit: KRS_HIT };
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // The default marker {{company}} renders the first format.
      expect(result.values["company"]).toBe("Żabka Polska sp. z o.o.");
      // Each named format renders the same hit through its own template,
      // addressed by a flat dotted key matching the {{company.<key>}} marker.
      expect(result.values["company.full"]).toBe(
        "Żabka Polska sp. z o.o., seat in Poznań",
      );
      expect(result.values["company.short"]).toBe("Żabka Polska sp. z o.o.");
    }
    // Resolved once for the default + both named formats.
    expect(calls).toBe(1);
  });

  test("emits no value for an undeclared format key (stays unmatched)", async () => {
    const result = await resolveLookupFields({
      values: { company: "0000123456" },
      fields: [
        {
          path: "company",
          lookup: {
            registry: "krs",
            formats: [
              { key: "output_1", template: "[company name]" },
              { key: "full", template: "[company name], [seat]" },
            ],
          },
        },
      ],
      resolve: hitResolver(KRS_HIT),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.values["company.full"]).toBe(
        "Żabka Polska sp. z o.o., Poznań",
      );
      // An unknown key was never declared, so no value is emitted for it; the
      // {{company.unknown}} marker stays unmatched (the fill's diagnostic).
      expect(result.values["company.unknown"]).toBeUndefined();
    }
  });

  test("named-format values inherit the field's bold/italic markdown", async () => {
    const result = await resolveLookupFields({
      values: { company: "0000123456" },
      fields: [
        {
          path: "company",
          lookup: {
            registry: "krs",
            formats: [
              { key: "output_1", template: "[company name]" },
              { key: "full", template: "**[company name]**" },
            ],
          },
        },
      ],
      resolve: hitResolver(KRS_HIT),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.values["company.full"]).toEqual({
        paragraphs: [
          { runs: [{ text: "Żabka Polska sp. z o.o.", bold: true }] },
        ],
      });
    }
  });

  test("strips formatting markers when the field is Person + AI", async () => {
    // The aiAdapt pass rewrites plain string stubs only, so the rendered
    // output stays a string with the markers removed.
    const result = await resolveLookupFields({
      values: { buyer_krs: "0000123456" },
      fields: [
        {
          path: "buyer_krs",
          aiAdapt: true,
          lookup: {
            registry: "krs",
            formats: [
              {
                key: "output_1",
                template: "**[company name]**, seat: [seat]",
              },
            ],
          },
        },
      ],
      resolve: hitResolver(KRS_HIT),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.values["buyer_krs"]).toBe(
        "Żabka Polska sp. z o.o., seat: Poznań",
      );
    }
  });
});

describe("engine substitution of formatted lookup values", () => {
  const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  const WRAP = (body: string) =>
    `<w:document xmlns:w="${W_NS}"><w:body>${body}</w:body></w:document>`;

  test("renders multiple runs with bold/italic rPr inline", () => {
    const xml = WRAP(
      [
        "<w:p>",
        '<w:r><w:rPr><w:sz w:val="24"/></w:rPr>',
        '<w:t xml:space="preserve">Between {{buyer_krs}} and others</w:t>',
        "</w:r>",
        "</w:p>",
      ].join(""),
    );
    const value = lookupValueFromRendered("**Acme**, seat in *Poznań*");

    const result = patchXmlPart(xml, { buyer_krs: value });

    expect(result.changed).toBe(true);
    expect(result.xml).toContain("<w:b");
    expect(result.xml).toContain("<w:i");
    expect(result.xml).toContain("Acme");
    expect(result.xml).toContain(", seat in ");
    expect(result.xml).toContain("Poznań");
    // Each replacement run inherits the marker run's other formatting:
    // the source run + 3 replacement runs + the trailing-text run.
    expect(result.xml.match(/<w:sz /gu)).toHaveLength(5);
  });
});

describe("createDispatchLookupResolver — mocked dispatch", () => {
  // The resolver's dispatch is now keyed by every supported registry; spread
  // the real table and override only the krs handler these tests exercise.
  const stubDispatch = (
    override: Partial<RegistryHandler>,
  ): typeof BUSINESS_REGISTRY_DISPATCH => ({
    ...BUSINESS_REGISTRY_DISPATCH,
    krs: { ...BUSINESS_REGISTRY_DISPATCH.krs, ...override },
  });

  test("returns the hit from the registry handler's lookup", async () => {
    const resolver = createDispatchLookupResolver({
      dispatch: stubDispatch({ lookup: async () => KRS_HIT }),
    });
    const outcome = await resolver({ registry: "krs", query: "0000123456" });
    expect(outcome).toEqual({ type: "hit", hit: KRS_HIT });
  });

  test("maps a null hit to not-found", async () => {
    const resolver = createDispatchLookupResolver({
      dispatch: stubDispatch({ lookup: async () => null }),
    });
    const outcome = await resolver({ registry: "krs", query: "0000123456" });
    expect(outcome).toEqual({ type: "not-found" });
  });

  test("maps adapter validation errors to an error outcome", async () => {
    const resolver = createDispatchLookupResolver({
      dispatch: stubDispatch({
        lookup: () => {
          throw new KrsValidationError("KRS number must be 10 digits");
        },
      }),
    });
    const outcome = await resolver({ registry: "krs", query: "0000123456" });
    expect(outcome).toEqual({
      type: "error",
      message: "KRS number must be 10 digits",
    });
  });

  test("refuses an unconfigured registry without calling it", async () => {
    let lookupCalls = 0;
    const resolver = createDispatchLookupResolver({
      dispatch: stubDispatch({
        isDeployAvailable: () => false,
        lookup: async () => {
          lookupCalls += 1;
          return KRS_HIT;
        },
      }),
    });
    const outcome = await resolver({ registry: "krs", query: "0000123456" });
    expect(outcome).toEqual({
      type: "error",
      message: "The krs registry is not available in this deployment.",
    });
    expect(lookupCalls).toBe(0);
  });

  test.each([...BUSINESS_REGISTRY_SLUGS])(
    "resolves deployed %s without jurisdiction preferences",
    async (registry) => {
      let lookupCalls = 0;
      const hit = { ...KRS_HIT, registry };
      const resolver = createDispatchLookupResolver({
        dispatch: {
          ...BUSINESS_REGISTRY_DISPATCH,
          [registry]: {
            ...BUSINESS_REGISTRY_DISPATCH[registry],
            isDeployAvailable: () => true,
            isCanonicalId: () => true,
            lookup: async () => {
              lookupCalls += 1;
              return hit;
            },
          },
        },
      });
      const outcome = await resolver({ registry, query: hit.id });
      expect(outcome).toEqual({ type: "hit", hit });
      expect(lookupCalls).toBe(1);
    },
  );
});

describe("applyLookupFields — fill flow over a mocked dispatch", () => {
  test("rewrites the submitted KRS number in place and returns null", async () => {
    const values: Record<string, unknown> = { buyer_krs: "0000123456" };
    const error = await applyLookupFields(
      values,
      { fields: [krsField] },
      {
        resolve: createDispatchLookupResolver({
          dispatch: {
            ...BUSINESS_REGISTRY_DISPATCH,
            krs: {
              ...BUSINESS_REGISTRY_DISPATCH.krs,
              lookup: async () => KRS_HIT,
            },
          },
        }),
      },
    );
    expect(error).toBeNull();
    expect(values["buyer_krs"]).toBe(
      "Żabka Polska sp. z o.o., ul. Stanisława Matyi 8, 61-586 Poznań",
    );
  });

  test("returns the combined message when a lookup fails", async () => {
    const values: Record<string, unknown> = { buyer_krs: "0000123456" };
    const error = await applyLookupFields(
      values,
      { fields: [krsField] },
      {
        resolve: createDispatchLookupResolver({
          dispatch: {
            ...BUSINESS_REGISTRY_DISPATCH,
            krs: {
              ...BUSINESS_REGISTRY_DISPATCH.krs,
              lookup: async () => null,
            },
          },
        }),
      },
    );
    expect(error).toBe(
      'Field "buyer_krs": no company found in KRS for "0000123456".',
    );
    expect(values["buyer_krs"]).toBe("0000123456");
  });

  test("is a no-op without a manifest", async () => {
    const values: Record<string, unknown> = { buyer_krs: "0000123456" };
    const error = await applyLookupFields(values, null, {
      resolve: hitResolver(KRS_HIT),
    });
    expect(error).toBeNull();
    expect(values["buyer_krs"]).toBe("0000123456");
  });

  test("refuses an unconfigured registry during fill without calling it", async () => {
    let lookupCalls = 0;
    const values: Record<string, unknown> = { buyer_krs: "0000123456" };
    const error = await applyLookupFields(
      values,
      { fields: [krsField] },
      {
        resolve: createDispatchLookupResolver({
          dispatch: {
            ...BUSINESS_REGISTRY_DISPATCH,
            krs: {
              ...BUSINESS_REGISTRY_DISPATCH.krs,
              isDeployAvailable: () => false,
              lookup: async () => {
                lookupCalls += 1;
                return KRS_HIT;
              },
            },
          },
        }),
      },
    );
    expect(error).toBe(
      'Field "buyer_krs": KRS lookup failed: The krs registry is not available in this deployment.',
    );
    // The registry was never called; the submitted number is left untouched.
    expect(lookupCalls).toBe(0);
    expect(values["buyer_krs"]).toBe("0000123456");
  });

  test("resolves a deployed registry through fill without jurisdiction preferences", async () => {
    const values: Record<string, unknown> = { buyer_krs: "0000123456" };
    const error = await applyLookupFields(
      values,
      { fields: [krsField] },
      {
        resolve: createDispatchLookupResolver({
          dispatch: {
            ...BUSINESS_REGISTRY_DISPATCH,
            krs: {
              ...BUSINESS_REGISTRY_DISPATCH.krs,
              isDeployAvailable: () => true,
              lookup: async () => KRS_HIT,
            },
          },
        }),
      },
    );
    expect(error).toBeNull();
    expect(values["buyer_krs"]).toBe(
      "Żabka Polska sp. z o.o., ul. Stanisława Matyi 8, 61-586 Poznań",
    );
  });
});

// The full fill pipeline for a lookup with named output formats: the manifest
// declares one lookup field (`company`) with a default + a named `full`
// format. A document references the bare `{{company}}` (default rendering) and
// the keyed `{{company.full}}` (the named rendering of the SAME hit). Both must
// fill from one submitted registry number, in plain paragraphs, inside an
// `{% for %}` loop, and inside a table — the flat dotted `company.full` key the
// resolver writes has to survive flattenTemplateData and block expansion so the
// keyed marker is never left unmatched or surfaced as a separate field.
describe("named-format lookup — end-to-end fill", () => {
  const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  const WRAP = (body: string) =>
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<w:document xmlns:w="${W_NS}"><w:body>${body}</w:body></w:document>`;
  const P = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
  const CELL = (text: string) =>
    `<w:tc><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:tc>`;

  const makeDocx = async (documentXml: string): Promise<Buffer> => {
    const zip = new JSZip();
    zip.file("word/document.xml", documentXml);
    zip.file(
      "[Content_Types].xml",
      `<?xml version="1.0" encoding="UTF-8"?>` +
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `</Types>`,
    );
    return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
  };

  const docText = async (buffer: Buffer): Promise<string> => {
    const zip = await JSZip.loadAsync(buffer);
    return (await zip.file("word/document.xml")?.async("string")) ?? "";
  };

  const companyField: FieldMeta = {
    path: "company",
    inputType: "text",
    lookup: {
      registry: "krs",
      formats: [
        { key: "output_1", template: "[company name]" },
        { key: "full", template: "[company name], seat in [seat]" },
      ],
    },
  };
  const manifest: TemplateManifest = {
    version: 1,
    fields: [companyField],
  };
  const DEFAULT_RENDER = "Żabka Polska sp. z o.o.";
  const FULL_RENDER = "Żabka Polska sp. z o.o., seat in Poznań";

  test("discovery + merge keeps the lookup field, drops the format marker", async () => {
    const docx = await makeDocx(
      WRAP([P("{{company}}"), P("{{company.full}}")].join("")),
    );
    const discovered = await discoverTemplate(docx);
    const resolved = mergeManifestWithDiscovery(manifest, discovered);

    expect(resolved.find((f) => f.path === "company")?.lookup).toBeDefined();
    // `company.full` is a rendering of the one resolved hit, not a separate
    // fillable input, so it must not surface as its own ResolvedField.
    expect(resolved.some((f) => f.path === "company.full")).toBe(false);
  });

  test("fills the bare and keyed markers from one submitted number", async () => {
    const docx = await makeDocx(
      WRAP([P("{{company}}"), P("{{company.full}}")].join("")),
    );
    const withManifest = await authorFieldMarkers(docx, manifest.fields);
    const values: TemplateData = { company: "0000123456" };

    const stepError = await applyManifestFillSteps({
      values,
      manifest,
      resolveLookup: hitResolver(KRS_HIT),
    });
    expect(stepError).toBeNull();

    const result = await fillTemplate(withManifest, values);
    expect(result.unmatchedPlaceholders).toEqual([]);
    const text = await docText(result.buffer);
    expect(text).toContain(DEFAULT_RENDER);
    expect(text).toContain(FULL_RENDER);
  });

  test("the keyed marker survives #each block expansion", async () => {
    const docx = await makeDocx(
      WRAP(
        [
          P("{% for item in items %}"),
          P("{{ item.label }}: {{company}} / {{company.full}}"),
          P("{% endfor %}"),
        ].join(""),
      ),
    );
    const withManifest = await authorFieldMarkers(docx, manifest.fields);
    const values: TemplateData = {
      company: "0000123456",
      items: [{ label: "A" }, { label: "B" }],
    };

    const stepError = await applyManifestFillSteps({
      values,
      manifest,
      resolveLookup: hitResolver(KRS_HIT),
    });
    expect(stepError).toBeNull();

    const result = await fillTemplate(withManifest, values);
    expect(result.unmatchedPlaceholders).toEqual([]);
    const text = await docText(result.buffer);
    // One rendering per loop iteration: the flat company.full key resolves
    // inside every expanded copy, not just the first.
    expect(text.split(FULL_RENDER)).toHaveLength(3);
  });

  test("the keyed marker fills inside a table cell", async () => {
    const docx = await makeDocx(
      WRAP(
        `<w:tbl><w:tr>${CELL("{{company}}")}${CELL("{{company.full}}")}</w:tr></w:tbl>`,
      ),
    );
    const withManifest = await authorFieldMarkers(docx, manifest.fields);
    const values: TemplateData = { company: "0000123456" };

    const stepError = await applyManifestFillSteps({
      values,
      manifest,
      resolveLookup: hitResolver(KRS_HIT),
    });
    expect(stepError).toBeNull();

    const result = await fillTemplate(withManifest, values);
    expect(result.unmatchedPlaceholders).toEqual([]);
    const text = await docText(result.buffer);
    expect(text).toContain(DEFAULT_RENDER);
    expect(text).toContain(FULL_RENDER);
  });

  test("a keyed marker with no declared format stays unmatched", async () => {
    // No marker carries the lookup: `company` has none of its own here, so
    // the configuration reaches the fill steps directly.
    const docx = await makeDocx(WRAP(P("{{company.unknown}}")));
    const values: TemplateData = { company: "0000123456" };

    const stepError = await applyManifestFillSteps({
      values,
      manifest,
      resolveLookup: hitResolver(KRS_HIT),
    });
    expect(stepError).toBeNull();
    // No value is emitted for an undeclared key, so the marker is reported
    // unmatched rather than crashing the fill.
    expect(values["company.unknown"]).toBeUndefined();

    const result = await fillTemplate(docx, values);
    expect(result.unmatchedPlaceholders).toEqual(["company.unknown"]);
  });
});

// The documented model: a lookup field's `formats` are named renderings of the
// ONE resolved hit, each addressed in the DOCX by `{{path.key}}`. The first
// format is additionally the default for a bare `{{path}}` marker, so a
// template may address the formats by key only, by the bare marker only, or by
// both — always from a single registry round trip.
describe("lookup formats are addressed by their keys", () => {
  const WRAP = (inner: string) =>
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:body>${inner}</w:body></w:document>`;
  const P = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;

  const makeDocx = async (documentXml: string): Promise<Buffer> => {
    const zip = new JSZip();
    zip.file("word/document.xml", documentXml);
    zip.file(
      "[Content_Types].xml",
      `<?xml version="1.0" encoding="UTF-8"?>` +
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `</Types>`,
    );
    return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
  };

  const docText = async (buffer: Buffer): Promise<string> => {
    const zip = await JSZip.loadAsync(buffer);
    return (await zip.file("word/document.xml")?.async("string")) ?? "";
  };

  const NAME_RENDER = "Żabka Polska sp. z o.o.";
  const KRS_RENDER = "KRS 0000123456";

  test("the first format is addressable by its key, not only by the bare marker", async () => {
    const result = await resolveLookupFields({
      values: { company: "0000123456" },
      fields: [
        {
          path: "company",
          lookup: {
            registry: "krs",
            formats: [
              { key: "name", template: "[company name]" },
              { key: "krs", template: "KRS [registry number]" },
            ],
          },
        },
      ],
      resolve: hitResolver(KRS_HIT),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // The bare {{company}} marker keeps rendering the first format …
    expect(result.values["company"]).toBe(NAME_RENDER);
    // … and {{company.name}} addresses that same format by its key.
    expect(result.values["company.name"]).toBe(NAME_RENDER);
    expect(result.values["company.krs"]).toBe(KRS_RENDER);
  });

  test("one lookup fills a bare marker and a keyed marker together", async () => {
    const manifest: TemplateManifest = {
      version: 1,
      fields: [
        {
          path: "company",
          lookup: {
            registry: "krs",
            formats: [
              { key: "default", template: "[company name]" },
              { key: "krs", template: "KRS [registry number]" },
            ],
          },
        },
      ],
    };
    const docx = await makeDocx(
      WRAP([P("{{company}}"), P("{{company.krs}}")].join("")),
    );
    const withManifest = await authorFieldMarkers(docx, manifest.fields);

    // Both markers are discovered, and the merge keeps `company` as the one
    // fillable input while its format marker stays a rendering, not a field.
    const discovered = await discoverTemplate(docx);
    expect(discovered.placeholders.map((p) => p.name)).toEqual([
      "company",
      "company.krs",
    ]);
    const resolved = mergeManifestWithDiscovery(manifest, discovered);
    expect(resolved.map((f) => f.path)).toEqual(["company"]);

    let calls = 0;
    const values: TemplateData = { company: "0000123456" };
    const stepError = await applyManifestFillSteps({
      values,
      manifest,
      resolveLookup: async () => {
        calls += 1;
        return { type: "hit", hit: KRS_HIT };
      },
    });
    expect(stepError).toBeNull();
    expect(calls).toBe(1);

    const result = await fillTemplate(withManifest, values);
    expect(result.unmatchedPlaceholders).toEqual([]);
    const text = await docText(result.buffer);
    expect(text).toContain(NAME_RENDER);
    expect(text).toContain(KRS_RENDER);
  });

  test("dotted markers alone are filled by one lookup on their parent", async () => {
    const manifest: TemplateManifest = {
      version: 1,
      fields: [
        {
          path: "company",
          lookup: {
            registry: "krs",
            formats: [
              { key: "name", template: "[company name]" },
              { key: "krs", template: "KRS [registry number]" },
            ],
          },
        },
      ],
    };
    const docx = await makeDocx(
      WRAP([P("{{company.name}}"), P("{{company.krs}}")].join("")),
    );

    // No bare {{company}} marker: the format keys ARE the markers, and the
    // lookup root stays the single fillable input.
    const discovered = await discoverTemplate(docx);
    expect(discovered.placeholders.map((p) => p.name)).toEqual([
      "company.krs",
      "company.name",
    ]);
    const resolved = mergeManifestWithDiscovery(manifest, discovered);
    expect(resolved.map((f) => f.path)).toEqual(["company"]);

    let calls = 0;
    const values: TemplateData = { company: "0000123456" };
    const stepError = await applyManifestFillSteps({
      values,
      manifest,
      resolveLookup: async () => {
        calls += 1;
        return { type: "hit", hit: KRS_HIT };
      },
    });
    expect(stepError).toBeNull();
    expect(calls).toBe(1);

    const result = await fillTemplate(docx, values);
    expect(result.unmatchedPlaceholders).toEqual([]);
    const text = await docText(result.buffer);
    expect(text).toContain(NAME_RENDER);
    expect(text).toContain(KRS_RENDER);
  });
});

/**
 * Every built-in default is a party-identification clause, so it has to read
 * correctly both for a complete record and for one missing particulars: a
 * company with no share capital must not produce a dangling label.
 */
describe("built-in party clauses", () => {
  const textAddressOf = (textAddress: string | null) =>
    textAddress === null
      ? null
      : {
          line1: null,
          line2: null,
          postalCode: null,
          city: null,
          region: null,
          country: null,
          textAddress,
        };

  const ORSR_COMPANY = {
    ico: "31322832",
    name: "ESET, spol. s r.o.",
    legalForm: "Spoločnosť s ručením obmedzeným",
    address: null,
    courtFile: {
      court: "B",
      courtName: "Mestský súd Bratislava III",
      section: "Sro",
      insertNumber: "3586",
    },
    establishedAt: null,
    terminatedAt: null,
    shareCapital: null,
    shareCapitalPaid: null,
    actingClause: null,
    status: { type: "active" },
    statutoryBodies: [],
    stakeholders: [],
    registryUrl: "https://example.invalid/sk/31322832",
  } satisfies OrsrCompany;

  const orsrHit = (
    company: OrsrCompany,
    textAddress: string | null,
  ): BusinessRegistryHit => ({
    registry: "orsr",
    id: company.ico,
    name: company.name,
    legalForm: company.legalForm,
    address: textAddressOf(textAddress),
    registryUrl: company.registryUrl,
    details: { registry: "orsr", company },
  });

  test("ORSR renders the Slovak register citation in full", () => {
    expect(
      renderLookupOutput(
        null,
        orsrHit(ORSR_COMPANY, "Einsteinova 24, Bratislava"),
      ),
    ).toBe(
      "**ESET, spol. s r.o.**, so sídlom Einsteinova 24, Bratislava, IČO: 31 322 832, zapísaná v Obchodnom registri Mestského súdu Bratislava III, oddiel: Sro, vložka č. 3586/B",
    );
  });

  test("ORSR drops the address and the citation when they are absent", () => {
    expect(renderLookupOutput(null, orsrHit(ORSR_COMPANY, null))).toBe(
      "**ESET, spol. s r.o.**, IČO: 31 322 832, zapísaná v Obchodnom registri Mestského súdu Bratislava III, oddiel: Sro, vložka č. 3586/B",
    );
    expect(
      renderLookupOutput(
        null,
        orsrHit({ ...ORSR_COMPANY, courtFile: null }, null),
      ),
    ).toBe("**ESET, spol. s r.o.**, IČO: 31 322 832");
  });

  test("ORSR drops the citation when the court is not a known one", () => {
    expect(
      renderLookupOutput(
        null,
        orsrHit(
          {
            ...ORSR_COMPANY,
            courtFile: {
              ...ORSR_COMPANY.courtFile,
              court: "Z",
              courtName: null,
            },
          },
          null,
        ),
      ),
    ).toBe("**ESET, spol. s r.o.**, IČO: 31 322 832");
  });

  test("ORSR cites the court file in the register's own order", () => {
    expect(
      renderLookupOutput("[court file]", orsrHit(ORSR_COMPANY, "Bratislava")),
    ).toBe("Sro 3586/B");
    expect(
      renderLookupOutput(
        "oddiel [section], vložka [insert]",
        orsrHit(ORSR_COMPANY, "Bratislava"),
      ),
    ).toBe("oddiel Sro, vložka 3586/B");
  });

  const rpoHit = (
    legalForm: string | null,
    textAddress: string | null,
  ): BusinessRegistryHit => ({
    registry: "rpo",
    id: "00397865",
    name: "Univerzita Komenského v Bratislave",
    legalForm,
    address: textAddressOf(textAddress),
    registryUrl: "https://example.invalid/sk/00397865",
  });

  test("RPO renders its built-in format and drops particulars it lacks", () => {
    const complete = rpoHit(
      "Verejnoprávna inštitúcia",
      "Šafárikovo námestie 6, 814 99 Bratislava",
    );
    const expected =
      "**Univerzita Komenského v Bratislave**, Verejnoprávna inštitúcia, sídlo: Šafárikovo námestie 6, 814 99 Bratislava, IČO: 00397865";
    expect(renderLookupOutput(null, complete)).toBe(expected);
    // The advertised default template renders the same text.
    expect(
      renderLookupTemplate(
        BUSINESS_REGISTRY_FORMAT_CAPABILITIES.rpo.defaultFormat,
        complete,
      ),
    ).toBe(expected);
    expect(renderLookupOutput(null, rpoHit(null, null))).toBe(
      "**Univerzita Komenského v Bratislave**, IČO: 00397865",
    );
  });

  const brregHit = (textAddress: string | null): BusinessRegistryHit => ({
    registry: "brreg",
    id: "923609016",
    name: "EXEMPLE AS",
    legalForm: "AS",
    address: textAddressOf(textAddress),
    registryUrl: "https://example.invalid/no/923609016",
  });

  test("brreg renders the Norwegian party clause with and without an address", () => {
    expect(
      renderLookupOutput(null, brregHit("Snarøyveien 30, 1360 Fornebu")),
    ).toBe("**EXEMPLE AS**, org.nr. 923 609 016, Snarøyveien 30, 1360 Fornebu");
    expect(renderLookupOutput(null, brregHit(null))).toBe(
      "**EXEMPLE AS**, org.nr. 923 609 016",
    );
  });

  const prhHit = (textAddress: string | null): BusinessRegistryHit => ({
    registry: "prh",
    id: "0992445-3",
    name: "EXEMPLE OY",
    legalForm: null,
    address: textAddressOf(textAddress),
    registryUrl: "https://example.invalid/fi/0992445-3",
  });

  test("prh keeps the Y-tunnus hyphenated and parenthesised", () => {
    expect(
      renderLookupOutput(null, prhHit("Mannerheimintie 1, Helsinki")),
    ).toBe("**EXEMPLE OY** (Y-tunnus 0992445-3), Mannerheimintie 1, Helsinki");
    expect(renderLookupOutput(null, prhHit(null))).toBe(
      "**EXEMPLE OY** (Y-tunnus 0992445-3)",
    );
  });

  const companiesHouseHit = (
    jurisdiction: string | null,
    textAddress: string | null,
  ) =>
    ({
      registry: "companies-house",
      id: "01003142",
      name: "ROLLS-ROYCE PLC",
      legalForm: "plc",
      address: textAddressOf(textAddress),
      registryUrl: "https://example.invalid/uk/01003142",
      details: {
        registry: "companies-house",
        company: {
          companyNumber: "01003142",
          name: "ROLLS-ROYCE PLC",
          status: { type: "active" },
          statusDetail: null,
          type: "plc",
          subtype: null,
          jurisdiction,
          dateOfCreation: null,
          dateOfCessation: null,
          registeredOfficeAddress: null,
          serviceAddress: null,
          sicCodes: [],
          accounts: null,
          confirmationStatement: null,
          hasCharges: null,
          hasInsolvencyHistory: null,
          hasBeenLiquidated: null,
          previousNames: [],
          registryUrl: "https://example.invalid/uk/01003142",
        },
      },
    }) satisfies BusinessRegistryHit;

  test.each([
    ["llp", "limited liability partnership"],
    ["limited-partnership", "limited partnership"],
    ["plc", "public limited company"],
    ["ltd", "private limited company"],
  ])("companies-house preserves the %s legal form", (type, legalForm) => {
    const hit = companiesHouseHit("scotland", null);
    hit.details.company.type = type;
    expect(renderLookupOutput(null, hit)).toContain(
      `, ${legalForm} registered in Scotland`,
    );
    expect(renderLookupOutput(null, hit)).not.toContain("incorporated");
  });

  test.each([
    [
      "llp",
      "**ROLLS-ROYCE PLC**, limited liability partnership (company number 01003142)",
    ],
    [null, "**ROLLS-ROYCE PLC** (company number 01003142)"],
  ])(
    "companies-house handles legal form %s without a full record",
    (legalForm, expected) => {
      const { details: _details, ...hit } = companiesHouseHit(null, null);
      expect(renderLookupOutput(null, { ...hit, legalForm })).toBe(expected);
    },
  );

  test("companies-house keeps the sentence intact when particulars drop out", () => {
    expect(
      renderLookupOutput(
        null,
        companiesHouseHit("scotland", "1 George St, Edinburgh"),
      ),
    ).toBe(
      "**ROLLS-ROYCE PLC**, public limited company registered in Scotland (company number 01003142) whose registered office is at 1 George St, Edinburgh",
    );
    expect(
      renderLookupOutput(null, companiesHouseHit(null, "1 George St")),
    ).toBe(
      "**ROLLS-ROYCE PLC**, public limited company (company number 01003142) whose registered office is at 1 George St",
    );
    expect(renderLookupOutput(null, companiesHouseHit("scotland", null))).toBe(
      "**ROLLS-ROYCE PLC**, public limited company registered in Scotland (company number 01003142)",
    );
  });

  const FR_HEAD_OFFICE = {
    siret: "55208131700018",
    isHeadOffice: true,
    address: {
      textAddress: "22 avenue de Wagram, 75008 Paris",
      street: "22 avenue de Wagram",
      postalCode: "75008",
      city: "Paris",
      country: "France",
    },
    activityCode: null,
    status: { type: "open" },
    createdAt: null,
    closedAt: null,
  } as const;

  const frenchHit = (headOffice: typeof FR_HEAD_OFFICE | null) =>
    ({
      registry: "recherche-entreprises",
      id: "552081317",
      name: "EXEMPLE SA",
      legalForm: "5599",
      address: null,
      registryUrl: "https://example.invalid/fr/552081317",
      details: {
        registry: "recherche-entreprises",
        company: {
          siren: "552081317",
          name: "EXEMPLE SA",
          legalFormCode: "5599",
          shortName: null,
          headOffice,
          matchedEstablishment: null,
          status: { type: "active" },
          registeredAt: null,
          ceasedAt: null,
          directors: [],
          registryUrl: "https://example.invalid/fr/552081317",
        },
      },
    }) satisfies BusinessRegistryHit;

  test("recherche-entreprises names the siège social only when it has one", () => {
    expect(renderLookupOutput(null, frenchHit(FR_HEAD_OFFICE))).toBe(
      "**EXEMPLE SA**, dont le siège social est situé 22 avenue de Wagram, 75008 Paris, numéro SIREN 552 081 317",
    );
    // A branch address is not the siège social, so the clause drops rather
    // than describing the wrong establishment.
    expect(renderLookupOutput(null, frenchHit(null))).toBe(
      "**EXEMPLE SA**, numéro SIREN 552 081 317",
    );
  });

  const krsHit = (
    entity: Partial<{
      seat: string | null;
      nip: string | null;
      regon: string | null;
      shareCapital: { amount: string; currency: string } | null;
    }>,
  ) =>
    ({
      registry: "krs",
      id: "0000006865",
      name: "CD PROJEKT S.A.",
      legalForm: "spółka akcyjna",
      address: KRS_ADDRESS,
      registryUrl: "https://example.invalid/krs/0000006865",
      details: {
        registry: "krs",
        entity: {
          krsNumber: "0000006865",
          register: "RejP",
          name: "CD PROJEKT S.A.",
          legalForm: "spółka akcyjna",
          identifiers: {
            nip: entity.nip === undefined ? "7342867148" : entity.nip,
            regon: entity.regon === undefined ? "492707333" : entity.regon,
          },
          shareCapital:
            entity.shareCapital === undefined
              ? { amount: "100 000 000,00", currency: "PLN" }
              : entity.shareCapital,
          address: null,
          registeredSeat:
            entity.seat === null
              ? null
              : {
                  country: null,
                  voivodeship: null,
                  county: null,
                  commune: null,
                  locality: entity.seat ?? "Warszawa",
                },
          email: null,
          website: null,
          status: { type: "active" },
          registeredAt: null,
          lastEntryAt: null,
          registryUrl: "https://example.invalid/krs/0000006865",
        },
      },
    }) satisfies BusinessRegistryHit;

  test.each(["RejP", "RejS"] as const)(
    "krs identifies %s without inventing a sub-register",
    (register) => {
      const hit = krsHit({});
      expect(
        renderLookupOutput(null, {
          ...hit,
          details: {
            registry: "krs",
            entity: { ...hit.details.entity, register },
          },
        }),
      ).toContain("numer w Krajowym Rejestrze Sądowym: 0000006865");
    },
  );

  test.each(["5599", "9220", "7389"])(
    "recherche-entreprises identifies legal form %s without asserting RCS registration",
    (legalFormCode) => {
      const hit = frenchHit(FR_HEAD_OFFICE);
      hit.details.company.legalFormCode = legalFormCode;
      const output = renderLookupOutput(null, hit);
      expect(output).toContain("numéro SIREN 552 081 317");
      expect(output).not.toContain("commerce et des sociétés");
    },
  );

  test("krs renders the komparycja particulars it has", () => {
    expect(renderLookupOutput(null, krsHit({}))).toBe(
      "**CD PROJEKT S.A.**, siedziba: Warszawa, adres: ul. Stanisława Matyi 8, 61-586 Poznań, numer w Krajowym Rejestrze Sądowym: 0000006865, NIP 7342867148, REGON 492707333, kapitał zakładowy 100 000 000,00 PLN",
    );
  });

  test("krs omits the seat, NIP, REGON and capital labels when unfiled", () => {
    expect(
      renderLookupOutput(
        null,
        krsHit({ nip: null, regon: null, shareCapital: null, seat: null }),
      ),
    ).toBe(
      "**CD PROJEKT S.A.**, adres: ul. Stanisława Matyi 8, 61-586 Poznań, numer w Krajowym Rejestrze Sądowym: 0000006865",
    );
  });

  /** A saved copy of any string a registry ever shipped is an untouched
   *  built-in row, so it must still render through the built-in path rather
   *  than as authored text frozen on the old wording. */
  test.each([
    ["orsr", orsrHit(ORSR_COMPANY, "Einsteinova 24, Bratislava")],
    ["brreg", brregHit("Snarøyveien 30, 1360 Fornebu")],
    ["prh", prhHit("Mannerheimintie 1, Helsinki")],
    ["companies-house", companiesHouseHit("scotland", "1 George St")],
    ["recherche-entreprises", frenchHit(FR_HEAD_OFFICE)],
    ["krs", krsHit({})],
  ] as const)(
    "%s keeps every shipped default on the built-in path",
    (slug, hit) => {
      const builtIn = renderLookupHit(hit);
      expect(renderLookupOutput(null, hit)).toBe(builtIn);
      expect(
        renderLookupOutput(
          BUSINESS_REGISTRY_FORMAT_CAPABILITIES[slug].defaultFormat,
          hit,
        ),
      ).toBe(builtIn);
      const previous =
        Object.entries(PREVIOUS_DEFAULT_FORMATS).find(
          ([registry]) => registry === slug,
        )?.[1] ?? [];
      expect(previous.length).toBeGreaterThan(0);
      for (const format of previous) {
        expect(renderLookupOutput(format, hit)).toBe(builtIn);
      }
    },
  );
});
