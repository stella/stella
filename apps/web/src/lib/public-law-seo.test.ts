import { describe, expect, test } from "bun:test";
import { createTranslator } from "use-intl/core";

import {
  getTranslator,
  loadLocaleMessages,
  supportedLanguages,
  useI18nStore,
} from "@/i18n/i18n-store";
import cs from "@/i18n/langs/cs.json";
import en from "@/i18n/langs/en.json";

const t = createTranslator({ locale: "en", messages: en });

Object.assign(import.meta.env, {
  VITE_API_URL: "http://localhost:3001",
  VITE_PUBLIC_APP_URL: "http://localhost:3000",
});

const {
  createLegalCollectionJsonLd,
  createCaseLawDecisionJsonLd,
  createPublicLawCanonicalUrl,
  createPublicLawHead,
  createStatuteJsonLd,
} = await import("@/lib/public-law-seo");

describe("public law SEO", () => {
  test("textless pages explicitly emit noindex without changing the default head", () => {
    const input = {
      crawlAllowed: true,
      path: "/law/cases",
      title: "Case law",
      type: "article",
    } as const;
    const ordinary = createPublicLawHead(input);
    const textless = createPublicLawHead({ ...input, indexing: "noindex" });
    expect(textless.meta).toContainEqual({
      name: "robots",
      content: "noindex",
    });
    expect(
      textless.meta.filter(
        (meta) => !("name" in meta && meta.name === "robots"),
      ),
    ).toEqual(
      ordinary.meta.filter(
        (meta) => !("name" in meta && meta.name === "robots"),
      ),
    );
    expect(textless.links).toEqual([]);
  });
  test("non-crawlable pages keep nofollow even when the document is absent", () => {
    expect(
      createPublicLawHead({
        crawlAllowed: false,
        indexing: "noindex",
        path: "/law/cases",
        title: "Case law",
        type: "article",
      }).meta,
    ).toContainEqual({ name: "robots", content: "noindex,nofollow" });
  });
  test("builds absolute canonical URLs from the public app origin", () => {
    expect(createPublicLawCanonicalUrl("/law/cases")).toBe(
      "http://localhost:3000/law/cases",
    );
  });

  test("creates indexable canonical Open Graph metadata", () => {
    expect(
      createPublicLawHead({
        crawlAllowed: true,
        path: "/law/cases",
        title: "Case law | stella",
        type: "website",
      }),
    ).toEqual({
      links: [{ rel: "canonical", href: "http://localhost:3000/law/cases" }],
      meta: [
        { title: "Case law | stella" },
        {
          name: "robots",
          content:
            "index,follow,max-snippet:-1,max-image-preview:large,max-video-preview:-1",
        },
        { property: "og:title", content: "Case law | stella" },
        { property: "og:type", content: "website" },
        { property: "og:url", content: "http://localhost:3000/law/cases" },
        { name: "twitter:card", content: "summary" },
      ],
    });
  });

  test("defaults public-law metadata to noindex until launch", () => {
    expect(
      createPublicLawHead({
        path: "/law/cases",
        title: "Case law | stella",
        type: "website",
      }).meta,
    ).toContainEqual({ name: "robots", content: "noindex,nofollow" });
  });

  test("keeps meta robots noindex when crawling is not permitted", () => {
    // Mirrors a non-indexable deployment: sitemaps may still be served, but
    // every law page must stay noindex,nofollow.
    expect(
      createPublicLawHead({
        crawlAllowed: false,
        path: "/law/cases",
        title: "Case law | stella",
        type: "website",
      }).meta,
    ).toContainEqual({ name: "robots", content: "noindex,nofollow" });
  });

  test("adds hreflang alternates when public routes provide them", () => {
    expect(
      createPublicLawHead({
        alternateLinks: [
          {
            hreflang: "en",
            href: "http://localhost:3000/law/guidelines/wp29/dpia/v/wp-248-rev-01/lang/en",
          },
          {
            hreflang: "fr",
            href: "http://localhost:3000/law/guidelines/wp29/dpia/v/wp-248-rev-01/lang/fr",
          },
        ],
        path: "/law/guidelines/wp29/dpia/v/wp-248-rev-01/lang/en",
        crawlAllowed: true,
        title: "WP29 DPIA guidelines | stella",
        type: "article",
      }).links,
    ).toEqual([
      {
        rel: "canonical",
        href: "http://localhost:3000/law/guidelines/wp29/dpia/v/wp-248-rev-01/lang/en",
      },
      {
        rel: "alternate",
        hrefLang: "en",
        href: "http://localhost:3000/law/guidelines/wp29/dpia/v/wp-248-rev-01/lang/en",
      },
      {
        rel: "alternate",
        hrefLang: "fr",
        href: "http://localhost:3000/law/guidelines/wp29/dpia/v/wp-248-rev-01/lang/fr",
      },
    ]);
  });

  test("serializes JSON-LD through a safe head script", () => {
    expect(
      createPublicLawHead({
        crawlAllowed: true,
        jsonLd: { "@context": "https://schema.org", name: "</script>" },
        path: "/law/cases",
        title: "Case law | stella",
        type: "website",
      }).scripts,
    ).toEqual([
      {
        children: '{"@context":"https://schema.org","name":"\\u003c/script>"}',
        type: "application/ld+json",
      },
    ]);
  });

  test("creates case-law decision JSON-LD without private fields", async () => {
    expect(
      await createCaseLawDecisionJsonLd({
        canonicalUrl:
          "http://localhost:3000/law/cze/cases/nejvyssi-soud/2017-09-20/20-cdo--id",
        caseNumber: "20 Cdo 470/2017",
        country: "CZE",
        court: "Nejvyssi soud",
        decisionDate: "2017-09-20",
        decisionType: "judgment",
        ecli: "ECLI:CZ:NS:2017:20.CDO.470.2017.1",
        language: "cs",
        sourceName: "Nejvyssi soud",
        sourceUrl: "https://example.test/decision",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toEqual({
      "@context": "https://schema.org",
      "@type": "LegalDocument",
      citation: ["20 Cdo 470/2017", "ECLI:CZ:NS:2017:20.CDO.470.2017.1"],
      dateModified: "2026-01-01",
      datePublished: "2017-09-20",
      genre: "judgment",
      identifier: "ECLI:CZ:NS:2017:20.CDO.470.2017.1",
      inLanguage: "cs",
      isPartOf: {
        "@type": "Collection",
        name: cs.caseLaw.seo.collectionName,
      },
      mainEntityOfPage: {
        "@id":
          "http://localhost:3000/law/cze/cases/nejvyssi-soud/2017-09-20/20-cdo--id",
        "@type": "WebPage",
      },
      name: "20 Cdo 470/2017",
      provider: {
        "@type": "Organization",
        name: "Nejvyssi soud",
      },
      publisher: {
        "@type": "Organization",
        name: "Nejvyssi soud",
      },
      sameAs: "https://example.test/decision",
      spatialCoverage: "CZE",
      url: "http://localhost:3000/law/cze/cases/nejvyssi-soud/2017-09-20/20-cdo--id",
    });
  });

  test("does not publish invalid source URLs in case-law JSON-LD", async () => {
    expect(
      await createCaseLawDecisionJsonLd({
        canonicalUrl: "http://localhost:3000/law/cze/cases/court/date/id",
        caseNumber: "20 Cdo 470/2017",
        country: "CZE",
        court: "Nejvyssi soud",
        decisionDate: null,
        ecli: null,
        language: "cs",
        sourceUrl: "not a url",
      }),
    ).not.toHaveProperty("sameAs");
  });

  test("creates case-law collection JSON-LD", () => {
    expect(
      createLegalCollectionJsonLd({
        t,
        canonicalUrl: "http://localhost:3000/law/cases",
        description: "Public case-law database.",
        kind: "caseLaw",
        name: "Case law | stella",
      }),
    ).toEqual({
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      about: {
        "@type": "LegalDocument",
        name: en.common.caseLaw,
      },
      description: "Public case-law database.",
      mainEntity: {
        "@type": "ItemList",
        name: "Case law | stella",
      },
      name: "Case law | stella",
      url: "http://localhost:3000/law/cases",
    });
  });

  test("creates case-law collection JSON-LD with first-page decision links", () => {
    expect(
      createLegalCollectionJsonLd({
        t,
        canonicalUrl: "http://localhost:3000/law/cases",
        items: [
          {
            name: "20 Cdo 470/2017",
            url: "http://localhost:3000/law/cze/cases/court/date/decision",
          },
        ],
        kind: "caseLaw",
        name: "Case law | stella",
      }),
    ).toMatchObject({
      mainEntity: {
        "@type": "ItemList",
        itemListElement: [
          {
            "@type": "ListItem",
            position: 1,
            item: {
              "@type": "LegalDocument",
              name: "20 Cdo 470/2017",
              url: "http://localhost:3000/law/cze/cases/court/date/decision",
            },
          },
        ],
      },
    });
  });

  test("creates statute JSON-LD carrying the consolidation's version date", () => {
    expect(
      createStatuteJsonLd({
        canonicalUrl: "http://localhost:3000/law/cze/statutes/document",
        country: "CZE",
        documentType: "act",
        eli: "CZ/2012/89",
        language: "cs",
        sourceUrl: "https://example.test/statute",
        title: "Civil Code",
        versionValidFrom: "2020-01-01",
      }),
    ).toEqual({
      "@context": "https://schema.org",
      "@type": "Legislation",
      inLanguage: "cs",
      // The window this consolidation is valid over, never the date the act
      // was adopted: `legislationDate` would claim the latter.
      legislationDateVersion: "2020-01-01",
      legislationIdentifier: "CZ/2012/89",
      legislationJurisdiction: "CZE",
      legislationType: "act",
      mainEntityOfPage: {
        "@id": "http://localhost:3000/law/cze/statutes/document",
        "@type": "WebPage",
      },
      name: "Civil Code",
      sameAs: "https://example.test/statute",
      url: "http://localhost:3000/law/cze/statutes/document",
    });
  });

  test("omits statute fields the corpus has no value for", () => {
    const jsonLd = createStatuteJsonLd({
      canonicalUrl: "http://localhost:3000/law/cze/statutes/document",
      country: "CZE",
      documentType: null,
      eli: "CZ/2012/89",
      language: "cs",
      sourceUrl: "not a url",
      title: "Civil Code",
      versionValidFrom: null,
    });

    expect(jsonLd).not.toHaveProperty("legislationDate");
    expect(jsonLd).not.toHaveProperty("legislationDateVersion");
    expect(jsonLd).not.toHaveProperty("legislationType");
    expect(jsonLd).not.toHaveProperty("sameAs");
  });

  test("creates statute collection JSON-LD typed as legislation", () => {
    expect(
      createLegalCollectionJsonLd({
        t,
        canonicalUrl: "http://localhost:3000/law/cze/statutes",
        description: "Public statute database.",
        items: [
          {
            name: "Civil Code",
            url: "http://localhost:3000/law/cze/statutes/document",
          },
        ],
        kind: "statutes",
        name: "Statutes | stella",
      }),
    ).toEqual({
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      about: {
        "@type": "Legislation",
        name: "Statutes",
      },
      description: "Public statute database.",
      mainEntity: {
        "@type": "ItemList",
        itemListElement: [
          {
            "@type": "ListItem",
            position: 1,
            item: {
              "@type": "Legislation",
              name: "Civil Code",
              url: "http://localhost:3000/law/cze/statutes/document",
            },
          },
        ],
        name: "Statutes | stella",
      },
      name: "Statutes | stella",
      url: "http://localhost:3000/law/cze/statutes",
    });
  });
});

describe("public law metadata language", () => {
  test("keeps unsupported content languages independent of every interface locale", async () => {
    const initialLocale = useI18nStore.getState().loadedLang;
    try {
      for (const locale of supportedLanguages) {
        await useI18nStore.getState().setLang(locale);
        const interfaceTranslator = getTranslator();
        for (const language of ["it", "fi", "nl", "it-IT"]) {
          const decision = await createCaseLawDecisionJsonLd({
            canonicalUrl: "http://localhost:3000/law/cases",
            caseNumber: "20 Cdo 470/2017",
            country: "CZE",
            court: "Nejvyšší soud",
            decisionDate: null,
            ecli: null,
            language,
          });
          expect(decision).toMatchObject({
            inLanguage: language,
            isPartOf: {
              "@type": "Collection",
              name: en.caseLaw.seo.collectionName,
            },
          });
          expect(getTranslator()).toBe(interfaceTranslator);
        }
      }
    } finally {
      await useI18nStore.getState().setLang(initialLocale);
    }
  });

  test.each(supportedLanguages)(
    "uses the %s catalog without changing the interface language",
    async (locale) => {
      const interfaceTranslator = getTranslator();
      const messages = await loadLocaleMessages(locale);
      const translate = createTranslator({ locale, messages });
      const canonicalUrl = "http://localhost:3000/law/cases";
      const decision = await createCaseLawDecisionJsonLd({
        canonicalUrl,
        caseNumber: "20 Cdo 470/2017",
        country: "CZE",
        court: "Nejvyšší soud",
        decisionDate: null,
        ecli: null,
        language: locale,
      });
      expect(getTranslator()).toBe(interfaceTranslator);
      expect(decision).toMatchObject({
        "@type": "LegalDocument",
        inLanguage: locale,
        isPartOf: {
          "@type": "Collection",
          name: messages.caseLaw.seo.collectionName,
        },
        name: "20 Cdo 470/2017",
        publisher: { "@type": "Organization", name: "Nejvyšší soud" },
      });

      for (const description of [
        translate("caseLaw.seo.description"),
        translate("caseLaw.seo.scopedDescription", { scope: "CZE" }),
        translate("caseLaw.seo.homeDescription"),
        translate("caseLaw.coverage.description"),
      ]) {
        const name = translate("common.caseLaw");
        expect(
          createLegalCollectionJsonLd({
            t: translate,
            canonicalUrl,
            kind: "caseLaw",
            name,
            description,
          }),
        ).toMatchObject({
          "@type": "CollectionPage",
          about: { "@type": "LegalDocument", name: messages.common.caseLaw },
          mainEntity: { "@type": "ItemList", name },
          name,
          description,
        });
      }
      expect(
        createLegalCollectionJsonLd({
          t: translate,
          canonicalUrl,
          kind: "statutes",
          name: translate("statutes.title"),
          description: translate("statutes.description"),
        }),
      ).toMatchObject({
        "@type": "CollectionPage",
        about: { "@type": "Legislation", name: messages.statutes.title },
        description: messages.statutes.description,
      });
    },
  );

  test("keeps concurrent document languages independent and normalizes content tags", async () => {
    const decisions = await Promise.all(
      ["cs-CZ", "EN-gb", "ar", "pt"].map(
        async (language) =>
          await createCaseLawDecisionJsonLd({
            canonicalUrl: "http://localhost:3000/law/cases",
            caseNumber: "20 Cdo 470/2017",
            country: "CZE",
            court: "Nejvyšší soud",
            decisionDate: null,
            ecli: null,
            language,
          }),
      ),
    );
    const catalogs = await Promise.all([
      loadLocaleMessages("cs"),
      loadLocaleMessages("en"),
      loadLocaleMessages("ar"),
      loadLocaleMessages("pt-BR"),
    ]);
    expect(decisions.map((decision) => decision["isPartOf"])).toEqual(
      catalogs.map((messages) => ({
        "@type": "Collection",
        name: messages.caseLaw.seo.collectionName,
      })),
    );
  });
});
