import { panic } from "better-result";

export type InterpretationScenario = {
  id: string;
  request: string;
  jurisdiction: string;
  requirement:
    | "methods"
    | "coverage"
    | "conflict"
    | "contract"
    | "no-case-law"
    | "no-overlay"
    | "provenance";
};

const provision =
  'Synthetic Park Act, section 3, version effective 2026-01-01: "Vehicles are prohibited in the park." Jurisdiction: Czechia. No definitions or legislative history have been supplied.';
export const INTERPRETATION_SCENARIOS = [
  {
    jurisdiction: "cze",
    id: "statute-meaning",
    request: `${provision} What does vehicles mean? Answer in English.`,
    requirement: "methods",
  },
  {
    jurisdiction: "cze",
    id: "situation-coverage",
    request: `${provision} Does it cover an electric scooter used for commuting? Answer in English.`,
    requirement: "coverage",
  },
  {
    jurisdiction: "cze",
    id: "methods-conflict",
    request: `${provision} The supplied legislative record says the aim is preventing motor traffic; the wording could include bicycles. Explain the conflict and how to resolve it. Answer in English.`,
    requirement: "conflict",
  },
  {
    jurisdiction: "cze",
    id: "contract-clause",
    request:
      'Synthetic lease, clause 4: "No vehicles may be stored in the courtyard." Governing law: Czech law, signed 2026-01-01. Both parties say they intended to exclude motor cars only. Interpret it for bicycle storage. Answer in English.',
    requirement: "contract",
  },
  {
    jurisdiction: "cze",
    id: "no-case-law",
    request: `${provision} Explain whether bicycles are covered and disclose the limits of the available authorities. Answer in English.`,
    requirement: "no-case-law",
  },
  {
    jurisdiction: "can",
    id: "missing-overlay",
    request:
      'Synthetic Park Act, section 3, version effective 2026-01-01: "Vehicles are prohibited in the park." Jurisdiction: Canada. Interpret vehicles, and disclose the limits of the available jurisdiction guidance. Answer in English.',
    requirement: "no-overlay",
  },
  {
    jurisdiction: "cze",
    id: "citation-provenance",
    request: `${provision} An unverified note mentions ECLI:CZ:TEST:2026:999. Search for relevant decisions and cite only verified authorities. Answer in English.`,
    requirement: "provenance",
  },
] as const satisfies readonly InterpretationScenario[];

export const FIXTURE_DECISION_ID = "11111111-1111-4111-8111-111111111111";
export const FIXTURE_IDENTIFIERS = [
  "ECLI:CZ:TEST:2026:123",
  "1 Test 123/2026",
] as const;

export type InterpretationCall = {
  name: string;
  input: unknown;
  accepted: boolean;
  discovered: readonly string[];
  read: readonly string[];
};

export const scoreInterpretation = ({
  scenario,
  text,
  calls,
  overlayAvailable,
}: {
  scenario: InterpretationScenario;
  text: string;
  calls: readonly InterpretationCall[];
  overlayAvailable: boolean;
}) => {
  const defects: string[] = [];
  const searched = calls.some(
    (call) => call.name === "search_case_law" && call.accepted,
  );
  if (!searched) {
    defects.push("no accepted case-law search");
  }
  if (calls.some((call) => !call.accepted)) {
    defects.push("rejected tool call");
  }
  const discovered = new Set<string>();
  const verified = new Set<string>();
  for (const call of calls) {
    for (const identifier of call.discovered) {
      discovered.add(identifier);
    }
    for (const identifier of call.read) {
      if (discovered.has(identifier)) {
        verified.add(identifier);
      } else {
        defects.push(`read before discovery: ${identifier}`);
      }
    }
  }
  for (const identifier of discovered) {
    if (!verified.has(identifier)) {
      defects.push(`discovered authority not read: ${identifier}`);
    }
  }
  const citations =
    text.match(/\bECLI:[A-Z]{2}:[A-Z0-9.]+:[0-9]{4}:[A-Z0-9.]+\b/giu) ?? [];
  citations.push(
    ...(text.match(/\b\d+\s+[A-Z][A-Za-z]*\s+\d+\/\d{4}\b/gu) ?? []),
  );
  if (
    verified.size > 0 &&
    !citations.some((citation) => verified.has(citation))
  ) {
    defects.push("missing official citation for read authority");
  }
  for (const citation of citations) {
    if (!verified.has(citation)) {
      defects.push(`unverified decision citation: ${citation}`);
    }
  }
  for (const method of [
    /language|linguistic|wording/iu,
    /system|context/iu,
    /histor|legislative record/iu,
    /purpose|teleolog/iu,
  ]) {
    if (!method.test(text)) {
      defects.push(`missing method: ${method.source}`);
    }
  }
  if (
    !/conclusion|on balance|in my view|likely|reading/iu.test(
      text.slice(0, 500),
    )
  ) {
    defects.push("missing opening conclusion");
  }
  if (!/counter|alternative|competing/iu.test(text)) {
    defects.push("missing counter-reading");
  }
  if (!/confidence|settled|strong|contested|open|uncertain/iu.test(text)) {
    defects.push("missing confidence assessment");
  }
  if (
    verified.size === 0 &&
    !/no (?:relevant |on.point |matching |verified )?(?:case law|decisions|authorities)|(?:search|case law).{0,80}(?:nothing|no results|no hits)|method.{0,30}alone/isu.test(
      text,
    )
  ) {
    defects.push("missing case-law limitation");
  }
  if (
    !overlayAvailable &&
    !/(?:no|missing|unavailable|absent).{0,60}(?:overlay|jurisdiction.specific)|(?:overlay|jurisdiction.specific).{0,60}(?:not available|unavailable|missing|absent|does not exist)/isu.test(
      text,
    )
  ) {
    defects.push("missing overlay limitation");
  }
  switch (scenario.requirement) {
    case "coverage":
      if (!/scooter/iu.test(text)) {
        defects.push("missing application to supplied facts");
      }
      break;
    case "conflict":
      if (
        !/conflict|tension|diverg/iu.test(text) ||
        !/priority|prevail|limit/iu.test(text)
      ) {
        defects.push("missing conflict and priority explanation");
      }
      break;
    case "contract":
      if (
        !/common intent|shared intent|parties.{0,30}inten/isu.test(text) ||
        !/governing law|Czech law|private document/iu.test(text)
      ) {
        defects.push("missing contract interpretation basis");
      }
      break;
    case "no-overlay":
      break;
    case "methods":
    case "no-case-law":
    case "provenance":
      break;
    default:
      scenario.requirement satisfies never;
      panic("Unhandled interpretation requirement");
  }
  return defects;
};
