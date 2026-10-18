import { panic } from "better-result";

import { loadCatalogue } from "@stll/catalogue";

import type { api } from "@/lib/api";
import type { PublicKnowledgeData } from "@/lib/knowledge/public-knowledge-api";
import type { loadPublicToolDetail } from "@/lib/public-tools-data";

const tool = loadCatalogue().find((entry) => entry.kind !== "skill");
if (tool === undefined) {
  panic("The route shell fixture needs a bundled non-skill catalogue entry");
}
export const KNOWLEDGE_FIXTURE_TOOL_SLUG = tool.slug;
const toolDetail = {
  displayName: tool.displayName,
  entry: tool,
  markdown: null,
} satisfies NonNullable<Awaited<ReturnType<typeof loadPublicToolDetail>>>;
const templateTitle = "Fixture confidentiality agreement";
const companyName = "Fixture registry company";

const pack = {
  id: "general-legal",
  name: "Fixture legal templates",
  version: "1.0.0",
  description: "Published templates for the route shell fixture",
  license: "CC-BY-4.0",
  licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
  source: {
    name: "Fixture source",
    url: "https://example.test/templates",
    retrievedAt: "2026-10-01",
  },
  authors: [],
  jurisdictions: [{ country: "CZ" }],
  languages: ["en"],
  legalAreas: ["commercial"],
  lastReviewedAt: "2026-10-01",
  disclaimer: "Test fixture content",
  templateCount: 1,
  templates: [
    {
      id: "nda",
      title: templateTitle,
      jurisdictions: [{ country: "CZ" }],
      languages: ["en"],
      legalArea: "commercial",
      license: "CC-BY-4.0",
      fields: ["party_name"],
      sha256: "a".repeat(64),
    },
  ],
} satisfies PublicKnowledgeData<
  ReturnType<(typeof api.public.knowledge)["template-packs"]>["get"]
>;

const starters = {
  items: [
    {
      id: "nda",
      name: "Fixture NDA review",
      description: "Review a confidentiality agreement",
      documentTypeKey: "nda",
      positionCount: 1,
    },
  ],
} satisfies PublicKnowledgeData<
  (typeof api.public.knowledge)["playbook-starters"]["get"]
>;
const preview = {
  paragraphs: [
    {
      index: 0,
      text: "Confidential information is disclosed by {{party_name}}.",
      source: "body",
    },
  ],
  charCount: 65,
  structureErrors: [],
  clauseSlots: [],
} satisfies PublicKnowledgeData<
  ReturnType<
    ReturnType<(typeof api.public.knowledge)["template-packs"]>["templates"]
  >["preview"]["get"]
>;

export const knowledgeFixtureResponse = (
  pathname: string,
): Response | undefined => {
  if (pathname === "/v1/templates/lookup-formats") {
    return Response.json({
      items: [],
      nextCursor: null,
      limit: 25,
      defaultFormat: null,
      userDefaultFormat: null,
    } satisfies NonNullable<
      Awaited<
        ReturnType<(typeof api.templates)["lookup-formats"]["get"]>
      >["data"]
    >);
  }
  if (pathname === "/v1/templates/lookup-preview") {
    return Response.json({ rendered: companyName } satisfies NonNullable<
      Awaited<
        ReturnType<(typeof api.templates)["lookup-preview"]["post"]>
      >["data"]
    >);
  }
  if (pathname === "/v1/contacts/business-registries") {
    return Response.json({
      type: "lookup",
      registry: "ares",
      hit: {
        registry: "ares",
        id: "27074358",
        name: companyName,
        legalForm: null,
        address: null,
        registryUrl: "https://example.test/company/27074358",
      },
    } satisfies NonNullable<
      Awaited<
        ReturnType<(typeof api.contacts)["business-registries"]["get"]>
      >["data"]
    >);
  }
  if (pathname === "/v1/style-sets") {
    return Response.json({
      items: [],
      nextCursor: null,
      limit: 50,
      styleSetsCountLimit: 100,
    } satisfies NonNullable<
      Awaited<ReturnType<(typeof api)["style-sets"]["get"]>>["data"]
    >);
  }
  if (pathname === "/v1/flows") {
    return Response.json({
      items: [],
      nextCursor: null,
      limit: 25,
    } satisfies NonNullable<Awaited<ReturnType<typeof api.flows.get>>["data"]>);
  }
  if (pathname === "/v1/clause-categories") {
    return Response.json({ categories: [] } satisfies NonNullable<
      Awaited<ReturnType<(typeof api)["clause-categories"]["get"]>>["data"]
    >);
  }
  if (pathname === "/v1/clauses") {
    return Response.json({
      items: [],
      nextCursor: null,
      limit: 50,
    } satisfies NonNullable<
      Awaited<ReturnType<typeof api.clauses.get>>["data"]
    >);
  }
  if (pathname === "/v1/time-timers") {
    return Response.json({
      items: [],
      nextCursor: null,
      limit: 100,
    } satisfies NonNullable<
      Awaited<ReturnType<(typeof api)["time-timers"]["get"]>>["data"]
    >);
  }
  if (pathname === "/v1/catalogue") {
    return Response.json({
      entries: [],
      practiceJurisdictions: [],
    } satisfies NonNullable<
      Awaited<ReturnType<typeof api.catalogue.get>>["data"]
    >);
  }
  if (pathname === "/v1/templates") {
    return Response.json({
      items: [],
      nextCursor: null,
      limit: 25,
      templatesCountLimit: 50,
    } satisfies NonNullable<
      Awaited<ReturnType<typeof api.templates.get>>["data"]
    >);
  }
  if (pathname === "/v1/template-categories") {
    return Response.json({ categories: [] } satisfies NonNullable<
      Awaited<ReturnType<(typeof api)["template-categories"]["get"]>>["data"]
    >);
  }
  if (pathname === "/v1/playbooks") {
    return Response.json({
      items: [],
      nextCursor: null,
      limit: 25,
    } satisfies NonNullable<
      Awaited<ReturnType<typeof api.playbooks.get>>["data"]
    >);
  }
  if (pathname === "/v1/playbooks/recent") {
    return Response.json({
      items: [],
      nextCursor: null,
      limit: 4,
    } satisfies NonNullable<
      Awaited<ReturnType<typeof api.playbooks.recent.get>>["data"]
    >);
  }
  if (pathname === "/v1/playbooks/starters") {
    return Response.json({
      items: [
        {
          starterId: "nda",
          name: "Fixture NDA review",
          description: "Review a confidentiality agreement",
          documentTypeKey: "nda",
          positionCount: 1,
        },
      ],
    } satisfies NonNullable<
      Awaited<ReturnType<typeof api.playbooks.starters.get>>["data"]
    >);
  }
  if (pathname === "/v1/public/knowledge/template-packs") {
    return Response.json({ items: [pack] } satisfies PublicKnowledgeData<
      (typeof api.public.knowledge)["template-packs"]["get"]
    >);
  }
  if (pathname === "/v1/public/knowledge/template-packs/general-legal") {
    return Response.json(pack);
  }
  if (
    pathname ===
    "/v1/public/knowledge/template-packs/general-legal/templates/nda/preview"
  ) {
    return Response.json(preview);
  }
  if (pathname === "/v1/public/knowledge/playbook-starters") {
    return Response.json(starters);
  }
  return undefined;
};

export const knowledgeFixtureReadyText = (
  routeId: string,
): string | undefined => {
  if (routeId === "/knowledge/company-formats/$registry/$companyId") {
    return companyName;
  }
  if (routeId === "/knowledge/tools_/$entry" || routeId === "/tools/$slug") {
    return toolDetail.displayName;
  }
  if (
    routeId === "/knowledge/templates_/catalogue/$packId/$templateId" ||
    routeId === "/knowledge/templates_/catalogue/"
  ) {
    return templateTitle;
  }
  return undefined;
};

export const knowledgeFixtureLoaderData = (routeId: string) => {
  if (routeId === "/knowledge/tools_/$entry") {
    return { page: "catalogue", ...toolDetail };
  }
  if (routeId === "/tools/$slug") {
    return toolDetail;
  }
  if (routeId === "/knowledge/templates_/catalogue/$packId/$templateId") {
    return { displayName: templateTitle };
  }
  return undefined;
};
