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
  const rowValues = (
    prefix: string,
    rows: readonly Readonly<Record<string, string>>[],
  ) =>
    Object.keys(rows.at(0) ?? {}).map(
      (column) =>
        [`${prefix}.${column}`, rows.map((row) => row[column])] as const,
    );
  const rawFieldValues = Object.fromEntries([
    ...Object.entries(input.cluster).map(
      ([column, value]) => [`cluster.${column}`, value] as const,
    ),
    ...Object.entries(input.docket).map(
      ([column, value]) => [`docket.${column}`, value] as const,
    ),
    ...Object.entries(input.court).map(
      ([column, value]) => [`court.${column}`, value] as const,
    ),
    ...rowValues("opinions[]", input.opinions),
    ...rowValues("citations[]", input.citations),
    ...(input.judgeRelations.status === "complete"
      ? rowValues("people[]", input.judgeRelations.people)
      : []),
  ]);
  return {
    buildDecision: async () => mapCourtListenerRecord(input).unwrap(),
    rawFieldValues,
  };
};
