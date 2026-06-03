import { describe, expect, test } from "bun:test";

Object.assign(import.meta.env, {
  VITE_API_URL: "http://localhost:3001",
  VITE_PUBLIC_APP_URL: "http://localhost:3000",
});

const {
  createCaseLawCollectionJsonLd,
  createCaseLawDecisionJsonLd,
  createPublicLawCanonicalUrl,
  createPublicLawHead,
} = await import("@/lib/public-law-seo");

describe("public law SEO", () => {
  test("builds absolute canonical URLs from the public app origin", () => {
    expect(createPublicLawCanonicalUrl("/law/cases")).toBe(
      "http://localhost:3000/law/cases",
    );
  });

  test("creates indexable canonical Open Graph metadata", () => {
    expect(
      createPublicLawHead({
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

  test("serializes JSON-LD through a safe head script", () => {
    expect(
      createPublicLawHead({
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

  test("creates case-law decision JSON-LD without private fields", () => {
    expect(
      createCaseLawDecisionJsonLd({
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
        name: "Stella case law",
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

  test("does not publish invalid source URLs in case-law JSON-LD", () => {
    expect(
      createCaseLawDecisionJsonLd({
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
      createCaseLawCollectionJsonLd({
        canonicalUrl: "http://localhost:3000/law/cases",
        description: "Public case-law database.",
        name: "Case law | stella",
      }),
    ).toEqual({
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      about: {
        "@type": "LegalDocument",
        name: "Case-law decisions",
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
      createCaseLawCollectionJsonLd({
        canonicalUrl: "http://localhost:3000/law/cases",
        items: [
          {
            name: "20 Cdo 470/2017",
            url: "http://localhost:3000/law/cze/cases/court/date/decision",
          },
        ],
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
});
