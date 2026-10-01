import { panic } from "better-result";

import { SK_COURT_REFORM_SOURCE } from "./sk-court-reform-source";

const REFORM_DATE = "2023-06-01";
const REFORM_ELI = "eli/sk/zz/2004/371";
const REFORM_URL =
  "https://static.slov-lex.sk/static/SK/ZZ/2004/371/20230601.html";

type Provision = keyof typeof SK_COURT_REFORM_SOURCE;
export type SkCourtSuccessionCitation = {
  eli: typeof REFORM_ELI;
  version: typeof REFORM_DATE;
  provision: Provision;
  url: string;
  quote: string;
  hashAlgorithm: "sha256";
  quotedSpanHash: string;
};

/** Names can share an ID only where the registry/decision states that ID. */
export type SkCourtIdentityEvidence = {
  registreGuid: string;
  registryName: string;
  decisionName?: string | undefined;
};

export type SkCourtSuccessionRef = {
  /** Literal court-name span, including the grammatical case in the statute. */
  statedName: string;
  /** Only fixed grammatical court-type inflections are derived for matching. */
  registryMatchName: string;
  registry:
    | {
        status: "resolved";
        registreGuid: string;
        evidence: "exact-registry-name" | "same-registry-id-decision-name";
      }
    | {
        status: "unresolved";
        reason: "no-exact-match" | "ambiguous-exact-match";
      };
};

type Subject = "all" | "criminal" | "family" | "commercial" | "other";
type ScopedSubject = Exclude<Subject, "all">;
export type SkCourtJurisdictionException = {
  type: "assigned-before-reform-non-predominant-agenda";
  assignedBefore: typeof REFORM_DATE;
  caseAgendaRelation: "non-predominant-for-assigned-judge";
  completion: "original-judge";
  afterQuashing: {
    quashedAfter: typeof REFORM_DATE;
    returnTo: "city-court-competent-under-post-reform-rules";
  };
  citation: SkCourtSuccessionCitation;
};

type RightsScope =
  | {
      relations: "all-rights-and-obligations";
      exceptions: readonly SkCourtSuccessionCitation[];
    }
  | {
      relations: "judge-state";
      predominantAgenda: ScopedSubject;
      excludedOffices: "city-court-presidents";
    }
  | {
      relations: "lay-judge-state";
      relatedJurisdictionProvision: "paragraf-18n.odsek-2";
    }
  | {
      relations: "employees-and-state-property";
      subject: ScopedSubject;
      propertyAdministeredOn: "2023-05-31";
      propertyUse: "transferred-agenda";
      itemization: "inter-court-agreement-required";
    }
  | {
      relations: "president-office";
      transition: "president-to-vice-president";
      term: "remainder-of-original-term";
    };

type EdgeBase = {
  id: string;
  effectiveFrom: typeof REFORM_DATE;
  from: SkCourtSuccessionRef;
  to: SkCourtSuccessionRef;
  citations: readonly SkCourtSuccessionCitation[];
};
export type SkCourtSuccessionEdge = EdgeBase &
  (
    | { kind: "renaming"; scope: { type: "court-name" } }
    | {
        kind: "jurisdiction-transfer";
        scope: {
          type: "jurisdiction";
          subject: Subject;
          /** Full statutory inclusions remain in the operative quote. */
          statedScope: string;
          exceptions: readonly SkCourtJurisdictionException[];
        };
      }
    | {
        kind: "rights-and-assets-succession";
        scope: RightsScope;
      }
  );

const cite = (provision: Provision): SkCourtSuccessionCitation => ({
  eli: REFORM_ELI,
  version: REFORM_DATE,
  provision,
  url: `${REFORM_URL}#${provision}`,
  ...SK_COURT_REFORM_SOURCE[provision],
  hashAlgorithm: "sha256",
});

const courtRef = (
  statedName: string,
  evidence: readonly SkCourtIdentityEvidence[],
): SkCourtSuccessionRef => {
  const registryMatchName = statedName
    .replace(/^Okresného súdu /u, "Okresný súd ")
    .replace(/^Mestského súdu /u, "Mestský súd ");
  const exact = evidence.filter(
    (record) => record.registryName === registryMatchName,
  );
  const aliases = evidence.filter(
    (record) => record.decisionName === registryMatchName,
  );
  const ids = new Set(
    [...exact, ...aliases].map((record) => record.registreGuid),
  );
  if (ids.size !== 1) {
    return {
      statedName,
      registryMatchName,
      registry: {
        status: "unresolved",
        reason: ids.size === 0 ? "no-exact-match" : "ambiguous-exact-match",
      },
    };
  }
  const registreGuid = ids.values().next().value;
  if (registreGuid === undefined) {
    return panic("Unique court registry ID missing");
  }
  return {
    statedName,
    registryMatchName,
    registry: {
      status: "resolved",
      registreGuid,
      evidence:
        exact.length > 0
          ? "exact-registry-name"
          : "same-registry-id-decision-name",
    },
  };
};

type BaseOptions = {
  provision: Provision;
  from: string;
  to: string;
  evidence: readonly SkCourtIdentityEvidence[];
  citations: readonly SkCourtSuccessionCitation[];
};
const base = ({
  provision,
  from,
  to,
  evidence,
  citations,
}: BaseOptions): EdgeBase => ({
  id: `${provision}:${from}:${to}`,
  effectiveFrom: REFORM_DATE,
  from: courtRef(from, evidence),
  to: courtRef(to, evidence),
  citations,
});

/** Parse only the frozen, cited operative court list; schema drift is a bug. */
const transferNames = (provision: Provision) => {
  const quote = SK_COURT_REFORM_SOURCE[provision].quote;
  const match =
    /(?<from>Okresného súdu .+?) na (?<to>(?:Okresný|Mestský) súd [^,.;]+)/u.exec(
      quote,
    );
  const from = match?.groups?.["from"];
  const to = match?.groups?.["to"];
  if (from === undefined || to === undefined) {
    return panic(`Missing court transfer in ${provision}`);
  }
  return { from: from.split(/, | a /u), to };
};

const LETTER_SUBJECTS = {
  a: "criminal",
  b: "family",
  c: "commercial",
  d: "other",
} as const satisfies Record<string, ScopedSubject>;

const isSubjectLetter = (
  letter: string,
): letter is keyof typeof LETTER_SUBJECTS =>
  Object.hasOwn(LETTER_SUBJECTS, letter);

const broadCourtEdges = (
  evidence: readonly SkCourtIdentityEvidence[],
): SkCourtSuccessionEdge[] => {
  const edges: SkCourtSuccessionEdge[] = [];
  const broadTransfers: Provision[] = [
    "paragraf-18l.odsek-1.pismeno-a",
    "paragraf-18l.odsek-1.pismeno-b",
    "paragraf-18l.odsek-1.pismeno-c",
    "paragraf-18l.odsek-1.pismeno-d",
    "paragraf-18l.odsek-1.pismeno-e",
    "paragraf-18l.odsek-1.pismeno-f",
    "paragraf-18l.odsek-1.pismeno-g",
    "paragraf-18l.odsek-1.pismeno-h",
    "paragraf-18l.odsek-1.pismeno-i",
    "paragraf-18l.odsek-1.pismeno-j",
    "paragraf-18l.odsek-1.pismeno-k",
    "paragraf-18l.odsek-1.pismeno-l",
    "paragraf-18l.odsek-1.pismeno-m",
    "paragraf-18m.odsek-2",
  ];
  for (const provision of broadTransfers) {
    const transfer = transferNames(provision);
    const citations = [cite(provision)];
    if (provision.startsWith("paragraf-18l.")) {
      citations.unshift(cite("paragraf-18l.odsek-1"));
    }
    for (const from of transfer.from) {
      const common = base({
        provision,
        from,
        to: transfer.to,
        evidence,
        citations,
      });
      edges.push({
        ...common,
        id: `${common.id}:jurisdiction`,
        kind: "jurisdiction-transfer",
        scope: {
          type: "jurisdiction",
          subject: "all",
          statedScope: citations.map(({ quote }) => quote).join(" "),
          exceptions: [],
        },
      });
      edges.push({
        ...common,
        id: `${common.id}:rights`,
        kind: "rights-and-assets-succession",
        scope: { relations: "all-rights-and-obligations", exceptions: [] },
      });
    }
  }
  const renamings: Provision[] = [
    "paragraf-18m.odsek-1",
    "paragraf-18n.odsek-1.pismeno-a",
    "paragraf-18n.odsek-1.pismeno-b",
    "paragraf-18n.odsek-1.pismeno-c",
    "paragraf-18n.odsek-1.pismeno-d",
  ];
  for (const provision of renamings) {
    const match =
      /^(?<from>Okresný súd .+?) (?:sa od 1\. júna 2023 )?označuje ako (?<to>Mestský súd .+?)[,.]$/u.exec(
        SK_COURT_REFORM_SOURCE[provision].quote,
      );
    const from = match?.groups?.["from"];
    const to = match?.groups?.["to"];
    if (from === undefined || to === undefined) {
      return panic(`Missing court renaming in ${provision}`);
    }
    const citations = [cite(provision)];
    if (provision.startsWith("paragraf-18n.")) {
      citations.unshift(cite("paragraf-18n.odsek-1"));
    }
    edges.push({
      ...base({ provision, from, to, evidence, citations }),
      kind: "renaming",
      scope: { type: "court-name" },
    });
  }
  return edges;
};

const bratislavaSubjectEdges = (
  evidence: readonly SkCourtIdentityEvidence[],
): SkCourtSuccessionEdge[] => {
  const edges: SkCourtSuccessionEdge[] = [];
  for (const letter of Object.keys(LETTER_SUBJECTS)) {
    if (!isSubjectLetter(letter)) {
      return panic("Unknown court reform subject");
    }
    const subject = LETTER_SUBJECTS[letter];
    const provision = `paragraf-18n.odsek-2.pismeno-${letter}` as const;
    const transfer = transferNames(provision);
    for (const from of transfer.from) {
      const common = base({
        provision,
        from,
        to: transfer.to,
        evidence,
        citations: [
          cite("paragraf-18n.odsek-2"),
          cite(provision),
          cite("paragraf-18n.odsek-3"),
        ],
      });
      edges.push({
        ...common,
        kind: "jurisdiction-transfer",
        scope: {
          type: "jurisdiction",
          subject,
          statedScope: SK_COURT_REFORM_SOURCE[provision].quote,
          exceptions: [
            {
              type: "assigned-before-reform-non-predominant-agenda",
              assignedBefore: REFORM_DATE,
              caseAgendaRelation: "non-predominant-for-assigned-judge",
              completion: "original-judge",
              afterQuashing: {
                quashedAfter: REFORM_DATE,
                returnTo: "city-court-competent-under-post-reform-rules",
              },
              citation: cite("paragraf-18n.odsek-3"),
            },
          ],
        },
      });
    }
    const judges = `paragraf-18n.odsek-5.pismeno-${letter}` as const;
    const employees = `paragraf-18n.odsek-8.pismeno-${letter}` as const;
    for (const from of transferNames(judges).from) {
      edges.push({
        ...base({
          provision: judges,
          from,
          to: transferNames(judges).to,
          evidence,
          citations: [
            cite("paragraf-18n.odsek-5"),
            cite(judges),
            cite(provision),
            cite("paragraf-18n.odsek-6"),
          ],
        }),
        kind: "rights-and-assets-succession",
        scope: {
          relations: "judge-state",
          predominantAgenda: subject,
          excludedOffices: "city-court-presidents",
        },
      });
    }
    const employeeTransfer = transferNames(employees);
    for (const from of employeeTransfer.from) {
      edges.push({
        ...base({
          provision: employees,
          from,
          to: employeeTransfer.to,
          evidence,
          citations: [
            cite("paragraf-18n.odsek-8"),
            cite(employees),
            cite(provision),
            cite("paragraf-18n.odsek-9"),
          ],
        }),
        kind: "rights-and-assets-succession",
        scope: {
          relations: "employees-and-state-property",
          subject,
          propertyAdministeredOn: "2023-05-31",
          propertyUse: "transferred-agenda",
          itemization: "inter-court-agreement-required",
        },
      });
    }
  }
  return edges;
};

const bratislavaRightsEdges = (
  evidence: readonly SkCourtIdentityEvidence[],
): SkCourtSuccessionEdge[] => {
  const edges: SkCourtSuccessionEdge[] = [];
  const residual = "paragraf-18n.odsek-4";
  const residualTransfer = transferNames(residual);
  const residualExceptions = [
    cite("paragraf-18n.odsek-5"),
    cite("paragraf-18n.odsek-6"),
    cite("paragraf-18n.odsek-7"),
    cite("paragraf-18n.odsek-8"),
    cite("paragraf-18n.odsek-9"),
    cite("paragraf-18n.odsek-10"),
  ];
  for (const letter of Object.keys(LETTER_SUBJECTS)) {
    if (!isSubjectLetter(letter)) {
      return panic("Unknown court reform subject");
    }
    residualExceptions.push(
      cite(`paragraf-18n.odsek-5.pismeno-${letter}`),
      cite(`paragraf-18n.odsek-8.pismeno-${letter}`),
    );
  }
  for (const from of residualTransfer.from) {
    edges.push({
      ...base({
        provision: residual,
        from,
        to: residualTransfer.to,
        evidence,
        citations: [cite(residual)],
      }),
      kind: "rights-and-assets-succession",
      scope: {
        relations: "all-rights-and-obligations",
        exceptions: residualExceptions,
      },
    });
  }
  const layJudges = "paragraf-18n.odsek-7";
  const layTransfer = transferNames(layJudges);
  for (const from of layTransfer.from) {
    edges.push({
      ...base({
        provision: layJudges,
        from,
        to: layTransfer.to,
        evidence,
        citations: [cite(layJudges), cite("paragraf-18n.odsek-2")],
      }),
      kind: "rights-and-assets-succession",
      scope: {
        relations: "lay-judge-state",
        relatedJurisdictionProvision: "paragraf-18n.odsek-2",
      },
    });
  }
  const president = "paragraf-18n.odsek-10";
  const presidentQuote = SK_COURT_REFORM_SOURCE[president].quote;
  const match =
    /^Predseda (?<from>Okresného súdu .+?) je .+? podpredsedom (?<to>Mestského súdu [^;]+)/u.exec(
      presidentQuote,
    );
  const from = match?.groups?.["from"];
  const to = match?.groups?.["to"];
  if (from === undefined || to === undefined) {
    return panic("Missing court president transition");
  }
  const common = base({
    provision: president,
    from,
    to,
    evidence,
    citations: [cite(president)],
  });
  edges.push({
    ...common,
    kind: "rights-and-assets-succession",
    scope: {
      relations: "president-office",
      transition: "president-to-vice-president",
      term: "remainder-of-original-term",
    },
  });
  return edges;
};

/** All relationships come from operative text, never registry parent IDs. */
export const getSkCourtSuccessionEdges = (
  evidence: readonly SkCourtIdentityEvidence[] = [],
): readonly SkCourtSuccessionEdge[] => [
  ...broadCourtEdges(evidence),
  ...bratislavaSubjectEdges(evidence),
  ...bratislavaRightsEdges(evidence),
];

let referenceIndex: ReadonlyMap<string, readonly string[]> | undefined;

const courtReferenceIndex = () => {
  if (referenceIndex !== undefined) {
    return referenceIndex;
  }
  // The frozen statute graph bounds this cache; no publisher fetch or DB state enters it.
  const index = new Map<string, string[]>();
  for (const { id, from, to } of getSkCourtSuccessionEdges()) {
    for (const name of new Set([
      from.registryMatchName,
      to.registryMatchName,
    ])) {
      const ids = index.get(name);
      if (ids === undefined) {
        index.set(name, [id]);
      } else {
        ids.push(id);
      }
    }
  }
  referenceIndex = index;
  return referenceIndex;
};

/** Store references to the canonical graph rather than duplicate statute text per decision. */
export const skCourtSuccessionReferences = (
  statedName: string,
  registryName?: string,
) => {
  const index = courtReferenceIndex();
  return {
    eli: REFORM_ELI,
    version: REFORM_DATE,
    edgeIds: [
      ...new Set([
        ...(index.get(statedName) ?? []),
        ...(registryName === undefined ? [] : (index.get(registryName) ?? [])),
      ]),
    ],
  } as const;
};
