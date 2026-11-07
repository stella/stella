import { Result, TaggedError } from "better-result";
import * as cheerio from "cheerio";
import { isTag } from "domhandler";
import type { Element } from "domhandler";

import { declareFingerprintFields } from "@stll/errors";

import { EU_CELLAR_LIMITS } from "./eu-cellar-limits";
import { validCellarIri } from "./eu-cellar-metadata";
import { checkEuPublisherMarkup } from "./eu-xhtml";

const CDM = "http://publications.europa.eu/ontology/cdm#";
const OWL = "http://www.w3.org/2002/07/owl#";
const ANNOTATION = "http://publications.europa.eu/ontology/annotation#";
const XSD_DATE = "http://www.w3.org/2001/XMLSchema#date";
const { domNodes: MAX_NODES, metadataStatements: MAX_STATEMENTS } =
  EU_CELLAR_LIMITS;

type Subject = { type: "uri" | "bnode"; value: string };
type Uri = { type: "uri"; value: string };
type Literal = {
  type: "literal";
  value: string;
  datatype?: string;
  "xml:lang"?: string;
};
type Statement = { s: Subject; p: Uri; o: Uri | Literal };

class EuCellarNoticeError extends TaggedError("EuCellarNoticeError")<{
  message: string;
  reason: "malformed" | "limits" | "unsupported-layout" | "identity" | "empty";
}> {
  static {
    declareFingerprintFields(this, ["reason"]);
  }
}

const directIdentity = (scope: cheerio.Cheerio<Element>) => {
  const values = scope.children("URI").children("VALUE");
  return values.length === 1 ? values.text().trim() : "";
};

type ReadPropertiesOptions = {
  $: cheerio.CheerioAPI;
  scope: cheerio.Cheerio<Element>;
  subject: Subject;
  statements: Statement[];
};

/** Read one scope's direct properties; embedded notices never enter this graph. */
const readProperties = ({
  $,
  scope,
  subject,
  statements,
}: ReadPropertiesOptions) => {
  if (statements.length > MAX_STATEMENTS) {
    return;
  }
  const statement = (s: Subject, predicate: string, o: Uri | Literal) => {
    statements.push({ s, p: { type: "uri", value: predicate }, o });
  };
  for (const property of scope.children().toArray()) {
    if (property.name === "URI" || property.name === "EMBEDDED_NOTICE") {
      continue;
    }
    const node = $(property);
    const predicate =
      property.name === "SAMEAS"
        ? `${OWL}sameAs`
        : `${CDM}${property.name.toLowerCase()}`;
    const objects: (Uri | Literal)[] = [];
    for (const value of node.children("VALUE").toArray()) {
      const language =
        $(value).attr("LANG") ??
        $(value).attr("xml:lang") ??
        node.attr("LANG") ??
        node.attr("xml:lang") ??
        (node.children("LANG").first().text().trim() || undefined);
      objects.push({
        type: "literal",
        value: $(value).text().trim(),
        ...(node.attr("type") === "date" ? { datatype: XSD_DATE } : {}),
        ...(language === undefined ? {} : { "xml:lang": language }),
      });
    }
    for (const value of node.children("URI").children("VALUE").toArray()) {
      objects.push({ type: "uri", value: $(value).text().trim() });
    }
    for (const object of objects) {
      if (statements.length > MAX_STATEMENTS) {
        return;
      }
      statement(subject, predicate, object);
      for (const annotation of node.children("ANNOTATION").toArray()) {
        if (statements.length > MAX_STATEMENTS) {
          return;
        }
        const axiom: Subject = {
          type: "bnode",
          value: `${subject.value}:notice-annotation-${statements.length}`,
        };
        statement(axiom, `${OWL}annotatedSource`, {
          type: "uri",
          value: subject.value,
        });
        statement(axiom, `${OWL}annotatedProperty`, {
          type: "uri",
          value: predicate,
        });
        statement(axiom, `${OWL}annotatedTarget`, object);
        for (const field of $(annotation).children().toArray()) {
          if (statements.length > MAX_STATEMENTS) {
            return;
          }
          const language = $(field).attr("LANG") ?? $(field).attr("xml:lang");
          statement(axiom, `${ANNOTATION}${field.name.toLowerCase()}`, {
            type: "literal",
            value: $(field).text().trim(),
            ...(language === undefined ? {} : { "xml:lang": language }),
          });
        }
      }
    }
  }
};

/** Translate one complete branch notice into the metadata owner's statement contract. */
export const parseEuCellarNotice = (xml: string) => {
  const markupError = checkEuPublisherMarkup(xml);
  if (markupError !== null) {
    return Result.err(
      new EuCellarNoticeError({
        message: "CELLAR branch notice markup is invalid or exceeds limits",
        reason: markupError.reason === "limits" ? "limits" : "malformed",
      }),
    );
  }
  const $ = cheerio.load(xml, { xml: true });
  const notice = $.root().children("NOTICE");
  if (
    notice.length !== 1 ||
    $.root().children().length !== 1 ||
    notice.attr("type") !== "branch"
  ) {
    return Result.err(
      new EuCellarNoticeError({
        message: "Expected one CELLAR branch notice",
        reason: "unsupported-layout",
      }),
    );
  }
  let nodeCount = 1;
  for (const node of $("*").toArray().filter(isTag)) {
    nodeCount += node.children.length;
    if (nodeCount > MAX_NODES) {
      return Result.err(
        new EuCellarNoticeError({
          message: "CELLAR branch notice exceeds the node limit",
          reason: "limits",
        }),
      );
    }
  }
  const work = notice.children("WORK");
  const expression = notice.children("EXPRESSION");
  if (work.length !== 1 || expression.length !== 1) {
    return Result.err(
      new EuCellarNoticeError({
        message:
          "CELLAR branch notice must contain one direct Work and Expression",
        reason: "identity",
      }),
    );
  }
  const workIri = directIdentity(work);
  const expressionIri = directIdentity(expression);
  if (!validCellarIri(workIri) || !validCellarIri(expressionIri)) {
    return Result.err(
      new EuCellarNoticeError({
        message: "CELLAR branch notice has an invalid scope identity",
        reason: "identity",
      }),
    );
  }
  const statements: Statement[] = [];
  readProperties({
    $,
    scope: work,
    subject: { type: "uri", value: workIri },
    statements,
  });
  readProperties({
    $,
    scope: expression,
    subject: { type: "uri", value: expressionIri },
    statements,
  });
  const manifestations: { iri: string; type: string; items: string[] }[] = [];
  for (const node of notice.children("MANIFESTATION").toArray()) {
    const scope = $(node);
    const iri = directIdentity(scope);
    const types = scope.children("MANIFESTATION_TYPE").children("VALUE");
    const type = types.length === 1 ? types.text().trim() : "";
    if (!validCellarIri(iri) || type.length === 0) {
      return Result.err(
        new EuCellarNoticeError({
          message: "CELLAR branch notice has an invalid manifestation",
          reason: "identity",
        }),
      );
    }
    const items = scope
      .children("MANIFESTATION_HAS_ITEM")
      .children("URI")
      .children("VALUE")
      .toArray()
      .map((value) => $(value).text().trim());
    if (
      items.length === 0 ||
      items.some(
        (item) =>
          !URL.canParse(item) ||
          !item.startsWith(`${iri}/`) ||
          new URL(item).href !== item ||
          new URL(item).search.length > 0 ||
          new URL(item).hash.length > 0,
      )
    ) {
      return Result.err(
        new EuCellarNoticeError({
          message: "CELLAR manifestation requires its direct item IRIs",
          reason: "identity",
        }),
      );
    }
    manifestations.push({ iri, type, items });
    readProperties({
      $,
      scope,
      subject: { type: "uri", value: iri },
      statements,
    });
  }
  if (statements.length === 0) {
    return Result.err(
      new EuCellarNoticeError({
        message: "CELLAR branch notice contains no statements",
        reason: "empty",
      }),
    );
  }
  if (statements.length > MAX_STATEMENTS) {
    return Result.err(
      new EuCellarNoticeError({
        message: "CELLAR branch notice exceeds the statement limit",
        reason: "limits",
      }),
    );
  }
  return Result.ok({
    workIri,
    expressionIri,
    response: { results: { bindings: statements } },
    manifestations,
  });
};
