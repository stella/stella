/**
 * Read the Cellar branch notice the Publications Office serves for one CJEU
 * work, negotiated into one expression's language.
 *
 * The notice is the repository's own record of the decision, and it is the
 * only surface stating the judge-rapporteur, the Advocate General, the
 * publisher's cited-works list, the referring national judgment and the two
 * classification trees. The XHTML manifestation states none of them: they are
 * not in the decision's text.
 *
 * Three scopes, and keeping them apart is the whole of the reading:
 *
 *   NOTICE/WORK          the decision, shared by all 24 language rows
 *   NOTICE/EXPRESSION    this row's language alone (title, docket wording)
 *   NOTICE/MANIFESTATION one per format of that expression
 *
 * Only the direct children of those three are read. `WORK` also carries an
 * `EMBEDDED_NOTICE` per expression and per cited work, and a reader that
 * descended into them would attribute another work's facts to this one.
 *
 * Concept elements carry both an authority code (`OP-CODE`/`IDENTIFIER`) and
 * a `PREFLABEL` rendered in the negotiated language. Anything a row is
 * grouped or searched by is read from the code: the same work answers 24
 * notices, and a label read as the court would file one judgment under 24
 * different courts.
 */

import * as cheerio from "cheerio";
import type { Element } from "domhandler";

/** The three scopes a branch notice states facts at. */
const ECJ_NOTICE_SCOPE = {
  WORK: "WORK",
  EXPRESSION: "EXPRESSION",
  MANIFESTATION: "MANIFESTATION",
} as const;

/**
 * The two `EMBEDDED_NOTICE` containers under `WORK` whose contents describe
 * this decision rather than another work: the Reports-of-Cases container it
 * is published in, and the case file it belongs to.
 */
const EMBEDDED_WORK_CONTAINERS = [
  "WORK_PART_OF_WORK",
  "WORK_PART_OF_DOSSIER",
] as const;

/** A concept chain as the notice nests it: one level per `_N` suffix. */
type EcjNoticeConcept = {
  /** The authority code, stable across the 24 negotiated languages. */
  code: string;
  /** The label in the notice's own language. */
  label: string;
};

export type EcjNoticeManifestation = {
  type: string;
  uri: string;
};

/**
 * What one branch notice states about the decision and about the expression
 * it was negotiated for.
 *
 * Every field is optional: the notice is a record of what the Office holds,
 * and an older decision carries a fraction of what a recent one does.
 */
export type EcjNoticeFacts = {
  celex: string | undefined;
  ecli: string | undefined;
  /** Corporate-body code of the court that gave the decision (`CJ`, `GCEU`). */
  courtCode: string | undefined;
  /** CELEX document-type letters (`CJ`, `TJ`, `CC`, `CO`). */
  celexType: string | undefined;
  /** The resource-type label, as the notice renders it (`Judgment`). */
  form: string | undefined;
  /** Whether the Office holds this record as definitive or as provisional. */
  recordVersion: string | undefined;
  decisionDate: string | undefined;
  lodgedOn: string | undefined;
  /** Country the request originates in, as a label. */
  referringCountry: string | undefined;
  /** Authority code of the authentic language, which is not this row's. */
  procedureLanguage: string | undefined;
  procedureType: string | undefined;
  /** Who filed observations, as the notice labels them. */
  observations: readonly string[];
  rapporteur: string | undefined;
  advocateGeneral: string | undefined;
  /** The referring court, its chamber, date and national docket, as prose. */
  nationalJudgment: string | undefined;
  /** CELEX numbers of the instruments the decision interprets. */
  interprets: readonly string[];
  /** CELEX numbers of every work the decision cites. */
  citedWorks: readonly string[];
  /** Numbered bibliography of notes about the decision. */
  doctrine: readonly string[];
  subjectMatter: readonly EcjNoticeConcept[];
  caseLawSubjectMatter: readonly EcjNoticeConcept[];
  /** The Répertoire chain, deepest level last. */
  caseLawDirectory: readonly EcjNoticeConcept[];
  /** The revised Répertoire chain, same shape and a different tree. */
  caseLawDirectoryNew: readonly EcjNoticeConcept[];
  publishedInReports: boolean | undefined;
  /** The electronic Reports of Cases coordinates. */
  reportsReference: Readonly<Record<string, string>>;
  /** The Official Journal C-series communication announcing the decision. */
  ojNotice: string | undefined;
  /** The case file grouping judgment, opinion and abstract (`case:C-128/22`). */
  dossier: string | undefined;
  /** Sibling CELEX numbers of the same case event. */
  caseEventWorks: readonly string[];
  /** CELEX of the `_RES` abstract work, where the Office published one. */
  abstractCelex: string | undefined;
  /** The `#`-separated title, in the negotiated language. */
  title: string | undefined;
  /** The publisher's own docket wording, in the negotiated language. */
  caseIdentifier: string | undefined;
  /** Every format of this expression, so a later fetch needs no query. */
  manifestations: readonly EcjNoticeManifestation[];
};

type Selection = cheerio.Cheerio<Element>;

const textOf = (selection: Selection): string | undefined => {
  const value = selection.first().text().trim();
  return value.length > 0 ? value : undefined;
};

/**
 * Direct children of `parent` with this tag, and nothing an
 * `EMBEDDED_NOTICE` below it repeats.
 */
const children = (parent: Selection, tag: string): Selection =>
  parent.children(tag);

/** The `<VALUE>` of a direct child, which is how `type="data"` states one. */
const dataValue = (parent: Selection, tag: string): string | undefined =>
  textOf(children(parent, tag).children("VALUE"));

/** The authority code and label of a `type="concept"` child. */
const concept = (
  parent: Selection,
  tag: string,
): EcjNoticeConcept | undefined => {
  const element = children(parent, tag).first();
  const code = textOf(element.children("IDENTIFIER"));
  return code === undefined
    ? undefined
    : { code, label: textOf(element.children("PREFLABEL")) ?? code };
};

/** The identifier of the first `SAMEAS` naming a URI of this scheme. */
const sameAsIdentifier = (
  $: cheerio.CheerioAPI,
  element: Selection,
  scheme: string,
): string | undefined => {
  for (const uri of element.children("SAMEAS").children("URI").toArray()) {
    const node = $(uri);
    if (textOf(node.children("TYPE")) === scheme) {
      return textOf(node.children("IDENTIFIER"));
    }
  }
  return undefined;
};

const sameAsIdentifiers = (
  $: cheerio.CheerioAPI,
  parent: Selection,
  tag: string,
  scheme: string,
): readonly string[] => {
  const identifiers: string[] = [];
  for (const link of children(parent, tag).toArray()) {
    const identifier = sameAsIdentifier($, $(link), scheme);
    if (identifier !== undefined) {
      identifiers.push(identifier);
    }
  }
  return identifiers;
};

/**
 * A `concept_level` chain, ordered from the broadest level to the narrowest.
 *
 * The notice lists the levels in no particular order and names each by its
 * own `_N` element, so the depth is read off the element name rather than off
 * document order.
 */
const conceptChain = (
  $: cheerio.CheerioAPI,
  parent: Selection,
  tag: string,
): readonly EcjNoticeConcept[] => {
  const deepest = new Map<number, EcjNoticeConcept>();
  for (const group of children(parent, tag).toArray()) {
    for (const level of $(group).children().toArray()) {
      const match = /_(?<depth>\d+)$/u.exec(level.tagName.toUpperCase());
      const depth = match?.groups?.["depth"];
      const node = $(level);
      const code = textOf(node.children("IDENTIFIER"));
      if (depth === undefined || code === undefined) {
        continue;
      }
      deepest.set(Number.parseInt(depth, 10) * 1000 + deepest.size, {
        code,
        label: textOf(node.children("PREFLABEL")) ?? code,
      });
    }
  }
  return [...deepest.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, value]) => value);
};

/** Values of every `type="data"` child with this tag. */
const dataValues = (
  $: cheerio.CheerioAPI,
  parent: Selection,
  tag: string,
): readonly string[] => {
  const values: string[] = [];
  for (const element of children(parent, tag).toArray()) {
    const value = textOf($(element).children("VALUE"));
    if (value !== undefined) {
      values.push(value);
    }
  }
  return values;
};

/** Labels of every `type="concept"` child with this tag. */
const conceptLabels = (
  $: cheerio.CheerioAPI,
  parent: Selection,
  tag: string,
): readonly string[] => {
  const labels: string[] = [];
  for (const element of children(parent, tag).toArray()) {
    const node = $(element);
    const label = textOf(node.children("PREFLABEL"));
    if (label !== undefined) {
      labels.push(label);
    }
  }
  return labels;
};

/**
 * The person an agent link names.
 *
 * The Office states the agent twice — as an embedded notice carrying the
 * printed name, and as a cellar URI — and only the first is a name a reader
 * can be shown.
 */
const agentName = (parent: Selection, tag: string): string | undefined =>
  textOf(
    children(parent, tag)
      .first()
      .find("EMBEDDED_NOTICE > AGENT > AGENT_NAME > VALUE"),
  );

/**
 * The court, from the corporate body the work was created by.
 *
 * `WORK_CREATED_BY_AGENT` is stated twice with different meanings: once as a
 * link to the Advocate General, and once as a concept naming the court. Only
 * the concept form carries an authority code, which is what tells them apart
 * without reading a label the notice translates.
 */
const courtCode = (
  $: cheerio.CheerioAPI,
  work: Selection,
): string | undefined => {
  for (const element of work.children("WORK_CREATED_BY_AGENT").toArray()) {
    const node = $(element);
    if (textOf(node.children("URI").children("TYPE")) !== "corporate-body") {
      continue;
    }
    const code = textOf(node.children("IDENTIFIER"));
    if (code !== undefined) {
      return code;
    }
  }
  return undefined;
};

/** The Reports-of-Cases coordinates, from the container work the notice embeds. */
const reportsReference = (
  $: cheerio.CheerioAPI,
  work: Selection,
): Readonly<Record<string, string>> => {
  const container = work.find("WORK_PART_OF_WORK > EMBEDDED_NOTICE > WORK");
  const reference: Record<string, string> = {};
  for (const element of container.children().toArray()) {
    const tag = element.tagName.toUpperCase();
    if (!tag.startsWith("CONTAINER_CASE-LAW_")) {
      continue;
    }
    const value = textOf($(element).children("VALUE"));
    if (value !== undefined) {
      reference[tag.slice("CONTAINER_CASE-LAW_".length)] = value;
    }
  }
  return reference;
};

/** The `<national_judgement>` fragment, with its escaped markup stripped. */
const nationalJudgment = (raw: string | undefined): string | undefined => {
  if (raw === undefined) {
    return undefined;
  }
  const text = raw
    .replaceAll(/<\/?[a-z_]+>/giu, " ")
    .replaceAll(/\s+/gu, " ")
    .trim();
  return text.length > 0 ? text : undefined;
};

const noticeManifestations = (
  $: cheerio.CheerioAPI,
): readonly EcjNoticeManifestation[] => {
  const manifestations: EcjNoticeManifestation[] = [];
  for (const element of $("NOTICE > MANIFESTATION").toArray()) {
    const node = $(element);
    const type =
      textOf(node.children("MANIFESTATION_TYPE").children("VALUE")) ??
      node.attr("manifestation-type");
    const uri = textOf(node.children("URI").children("VALUE"));
    if (type !== undefined && uri !== undefined) {
      manifestations.push({ type, uri });
    }
  }
  return manifestations;
};

/** Parse one branch notice into the facts a row keeps from it. */
export const parseEcjNotice = (xml: string): EcjNoticeFacts => {
  const $ = cheerio.load(xml, { xml: true });
  const work = $("NOTICE > WORK");
  const expression = $("NOTICE > EXPRESSION");
  const dossier = work.find("WORK_PART_OF_DOSSIER > EMBEDDED_NOTICE > DOSSIER");
  const event = work.find("WORK_PART_OF_DOSSIER > EMBEDDED_NOTICE > EVENT");
  const published = dataValue(work, "CASE-LAW_PUBLISHED_IN_ERECUEIL");

  return {
    celex: dataValue(work, "RESOURCE_LEGAL_ID_CELEX"),
    ecli: dataValue(work, "ECLI"),
    courtCode: courtCode($, work),
    celexType: dataValue(work, "RESOURCE_LEGAL_TYPE"),
    form: concept(work, "WORK_HAS_RESOURCE-TYPE")?.label,
    recordVersion: dataValue(work, "VERSION"),
    decisionDate: dataValue(work, "WORK_DATE_DOCUMENT"),
    lodgedOn: dataValue(work, "RESOURCE_LEGAL_DATE_REQUEST_OPINION"),
    referringCountry: concept(work, "CASE-LAW_ORIGINATES_IN_COUNTRY")?.label,
    procedureLanguage: concept(work, "CASE-LAW_USES_PROCEDURE_LANGUAGE")?.code,
    procedureType: concept(
      work,
      "CASE-LAW_HAS_TYPE_PROCEDURE_CONCEPT_TYPE_PROCEDURE",
    )?.label,
    observations: conceptLabels($, work, "CASE-LAW_COMMENTED_BY_AGENT"),
    rapporteur: agentName(work, "CASE-LAW_DELIVERED_BY_JUDGE"),
    advocateGeneral: agentName(work, "CASE-LAW_DELIVERED_BY_ADVOCATE-GENERAL"),
    nationalJudgment: nationalJudgment(
      dataValue(work, "CASE-LAW_NATIONAL-JUDGEMENT"),
    ),
    interprets: sameAsIdentifiers(
      $,
      work,
      "CASE-LAW_INTERPRETES_RESOURCE_LEGAL",
      "celex",
    ),
    citedWorks: sameAsIdentifiers($, work, "WORK_CITES_WORK", "celex"),
    doctrine: dataValues($, work, "CASE-LAW_ARTICLE_JOURNAL_RELATED"),
    subjectMatter: conceptChain(
      $,
      work,
      "RESOURCE_LEGAL_IS_ABOUT_SUBJECT-MATTER",
    ),
    caseLawSubjectMatter: conceptChain(
      $,
      work,
      "CASE-LAW_IS-ABOUT_CASE-LAW-SUBJECT-MATTER",
    ),
    caseLawDirectory: conceptChain($, work, "CASE-LAW_IS_ABOUT_CONCEPT"),
    caseLawDirectoryNew: conceptChain(
      $,
      work,
      "CASE-LAW_IS_ABOUT_CONCEPT_NEW_CASE-LAW",
    ),
    publishedInReports:
      published === undefined ? undefined : published === "true",
    reportsReference: reportsReference($, work),
    ojNotice: sameAsIdentifier(
      $,
      work.children("CASE-LAW_COMMUNICATED_ON_BY_COMMUNICATION_CJEU").first(),
      "eli",
    ),
    dossier: textOf(dossier.children("DOSSIER_IDENTIFIER").children("VALUE")),
    caseEventWorks: sameAsIdentifiers($, event, "EVENT_CONTAINS_WORK", "celex"),
    abstractCelex: sameAsIdentifier(
      $,
      work.children("WORK_SUMMARIZED_BY_SUMMARY").first(),
      "celex",
    ),
    title: dataValue(expression, "EXPRESSION_TITLE"),
    caseIdentifier: dataValue(
      expression,
      "EXPRESSION_CASE-LAW_IDENTIFIER_CASE",
    ),
    manifestations: noticeManifestations($),
  };
};

/**
 * Every field name one stored notice states, qualified by the scope stating
 * it.
 *
 * Qualified because the scopes share tag names and mean a different thing by
 * them: `WORK/URI` is the decision's permanent address and `EXPRESSION/URI`
 * is this language variant's. The two embedded containers are read one level
 * down under the tag that holds them, so the Reports coordinates and the case
 * file are accounted for without descending into the cited works' notices.
 */
export const listEcjNoticeFields = (xml: string): readonly string[] => {
  const $ = cheerio.load(xml, { xml: true });
  const stated = new Set<string>();

  const addChildren = (parent: Selection, prefix: string): void => {
    for (const element of parent.children().toArray()) {
      stated.add(`${prefix}${element.tagName.toUpperCase()}`);
    }
  };

  const work = $("NOTICE > WORK");
  addChildren(work, `${ECJ_NOTICE_SCOPE.WORK}/`);
  for (const container of EMBEDDED_WORK_CONTAINERS) {
    for (const embedded of work
      .children(container)
      .children("EMBEDDED_NOTICE")
      .children()
      .toArray()) {
      addChildren($(embedded), `${ECJ_NOTICE_SCOPE.WORK}/${container}/`);
    }
  }
  addChildren($("NOTICE > EXPRESSION"), `${ECJ_NOTICE_SCOPE.EXPRESSION}/`);
  for (const manifestation of $("NOTICE > MANIFESTATION").toArray()) {
    addChildren($(manifestation), `${ECJ_NOTICE_SCOPE.MANIFESTATION}/`);
  }

  return [...stated];
};
