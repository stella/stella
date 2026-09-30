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
const config = () => propertyConfig({ seed: propertySeed(), numRuns: 20 });
const wrappers = fc.array(fc.constantFrom("div", "section", "blockquote"), {
  maxLength: 4,
});

test(
  "Czech administrative body markers retain their source order",
  () => {
    fc.assert(
      fc.property(markerPlan, wrappers, (plan, ancestors) => {
        const fixture = cheerio.load(nssUnitDecisionHtml);
        for (const tag of ancestors) {
          fixture("body").wrapInner(`<${tag}></${tag}>`);
        }
        fixture("body").append(
          "Text před oddílem.<h2>Nadpis oddílu</h2>Text za oddílem." +
            "<blockquote>Citovaný text.</blockquote>" +
            "<table><tr><td>První buňka</td><td>Druhá buňka</td></tr></table>" +
            "<div id='_ftn1'><p>Poznámka pod čarou.</p></div>",
        );
        const injected = injectMarkupMarkers({
          source: fixture.html(),
          selector: "body",
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
