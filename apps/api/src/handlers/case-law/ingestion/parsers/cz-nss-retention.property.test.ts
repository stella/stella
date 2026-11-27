import { expect, test } from "bun:test";
import fc from "fast-check";

import { parseNssDecisionHtml as uncheckedParseNssDecisionHtml } from "@stll/case-law-parsers/cz-nss";
import { validateAst } from "@stll/case-law-parsers/validate-ast";
import { load } from "@stll/html";
import {
  assertProperty,
  propertySeed,
  propertyTestTimeout,
} from "@stll/property-testing";

import { guardParser } from "@/api/tests/helpers/parser-reader-guard";

import { nssUnitDecisionHtml } from "./cz-nss.test-fixture";
import {
  expectMarkerRetention,
  injectMarkupMarkers,
  markerPlan,
} from "./marker-injection.test-helper";

const parseNssDecisionHtml = guardParser(uncheckedParseNssDecisionHtml);

const metadata = {
  caseNumber: "property-fixture",
  ecli: undefined,
  court: "fixture court",
  decisionDate: undefined,
  decisionType: undefined,
  sourceUrl: undefined,
};

const wrappers = fc.array(fc.constantFrom("div", "section", "blockquote"), {
  maxLength: 4,
});

test(
  "Czech administrative body markers retain their source order",
  () => {
    assertProperty(
      "Czech administrative body markers retain their source order",
      fc.property(markerPlan, wrappers, (plan, ancestors) => {
        const fixture = load(nssUnitDecisionHtml);
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
      { seed: propertySeed(), numRuns: 20 },
    );
  },
  propertyTestTimeout(30_000),
);
