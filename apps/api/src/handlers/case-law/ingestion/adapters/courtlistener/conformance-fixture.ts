import { panic } from "better-result";

import { COURTLISTENER_TEXT_FORMATS } from "../../parsers/courtlistener/select";
import { mapCourtListenerRecord } from "./map";
import {
  clusterRow,
  courtListenerRecord,
  docketRow,
  opinionRow,
  personRow,
} from "./test-records";

/** Synthetic column census: values exercise every declared projection, including optional ones. */
const record = () =>
  courtListenerRecord({
    cluster: clusterRow({
      judges: "White",
      case_name_short: "Daniels",
      case_name_full: "Daniels v. Borg",
      scdb_id: "1991-001",
      scdb_decision_direction: "1",
      scdb_votes_majority: "9",
      scdb_votes_minority: "0",
      source: "C",
      procedural_history: "Certiorari petition",
      attorneys: "Counsel",
      nature_of_suit: "Civil",
      posture: "Appeal",
      syllabus: "Syllabus",
      headnotes: "Headnote",
      summary: "Summary",
      disposition: "Denied",
      history: "Prior proceedings",
      other_dates: "1991",
      cross_reference: "Related case",
      correction: "Correction",
      headmatter: "<p>Daniels v. Borg</p>",
    }),
    docket: docketRow({
      appeal_from_str: "Court below",
      docket_number_core: "915746",
      docket_number_raw: "91-5746",
      date_argued: "1991-01-01",
    }),
    opinions: [
      opinionRow({
        ...Object.fromEntries(
          [...COURTLISTENER_TEXT_FORMATS, "xml_scan"]
            .filter((column) => column !== "xml_harvard")
            .map((column) => [
              column,
              `${column}: Žluťoučký 東京\u0000retained\u200btext`,
            ]),
        ),
        author_str: "Byron White",
        author_id: "3045",
        download_url: "https://www.courtlistener.com/example.pdf",
      }),
    ],
    judgeRelations: {
      status: "complete",
      people: [personRow()],
      joinedBy: [{ opinionId: "9109419", personId: "3045" }],
    },
  });

export const courtListenerConformanceFixture = () => {
  const input = record();
  const rawFieldValues: Record<string, string | string[]> = {};
  const addRowValues = (
    prefix: string,
    rows: readonly Readonly<Record<string, string>>[],
  ) => {
    const first = rows.at(0);
    if (first === undefined) {
      panic(`Missing CourtListener conformance rows: ${prefix}`);
    }
    for (const column of Object.keys(first)) {
      rawFieldValues[`${prefix}.${column}`] = rows.map((row) => {
        const value = row[column];
        return (
          value ??
          panic(`Missing CourtListener conformance column: ${prefix}.${column}`)
        );
      });
    }
  };
  for (const [column, value] of Object.entries(input.cluster)) {
    rawFieldValues[`cluster.${column}`] = value;
  }
  for (const [column, value] of Object.entries(input.docket)) {
    rawFieldValues[`docket.${column}`] = value;
  }
  for (const [column, value] of Object.entries(input.court)) {
    rawFieldValues[`court.${column}`] = value;
  }
  addRowValues("opinions[]", input.opinions);
  addRowValues("citations[]", input.citations);
  if (input.judgeRelations.status === "complete") {
    addRowValues("people[]", input.judgeRelations.people);
  }
  return {
    buildDecision: async () =>
      await Promise.resolve(mapCourtListenerRecord(input).unwrap()),
    rawFieldValues,
  };
};
