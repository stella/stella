import { expect, test } from "bun:test";
import * as cheerio from "cheerio";
import fc from "fast-check";

import {
  propertyConfig,
  propertySeed,
  propertyTestTimeout,
} from "@stll/property-testing";

import { validateAst } from "@/api/lib/legal-search/parsers/validate-ast";

import { parseNssDecisionHtml } from "./cz-nss";
import { nssUnitDecisionHtml } from "./cz-nss.test-fixture";
import {
  expectMarkerRetention,
  injectMarkupMarkers,
  markerPlan,
} from "./marker-injection.test-helper";

const metadata = {
  caseNumber: "property-fixture",
  ecli: undefined,
  court: "fixture court",
  decisionDate: undefined,
  decisionType: undefined,
  sourceUrl: undefined,
};
const retainedElements = "body p, body li, body td, body th, body div";
const config = () => propertyConfig({ seed: propertySeed(), numRuns: 20 });

test(
  "Czech administrative body markers retain their source order",
  () => {
    fc.assert(
      fc.property(markerPlan, fc.boolean(), (plan, nested) => {
        const fixture = cheerio.load(nssUnitDecisionHtml);
        if (nested) {
          fixture("body").wrapInner("<div></div>");
        }
        const injected = injectMarkupMarkers({
          source: fixture.html(),
          selector: retainedElements,
          excludedSelector:
            "div[style*='-aw-headerfooter-type'], script, style",
          plan,
        });
        const parsed = parseNssDecisionHtml({
          ...metadata,
          html: injected.source,
          detailMetadata: {},
        });
        expectMarkerRetention(parsed.fulltext, injected.markers);
        expect(validateAst(injected.source, parsed.documentAst.blocks).ok).toBe(
          true,
        );
      }),
      config(),
    );
  },
  propertyTestTimeout(30_000),
);
