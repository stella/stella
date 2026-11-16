import { caseLawDecisions } from "@/api/db/schema";

declare const db: {
  update: (table: unknown) => { set: (value: unknown) => void };
};

// oxlint-disable-next-line no-direct-decision-identifier-column-write/no-direct-decision-identifier-column-write -- fixture: ECLI write outside owner
db.update(caseLawDecisions).set({ ecli: "ECLI:XX:TEST:1" });
// oxlint-disable-next-line no-direct-decision-identifier-column-write/no-direct-decision-identifier-column-write -- fixture: docket write outside owner
db.update(caseLawDecisions).set({ caseNumber: "1 Test 1" });

// expect-clean: no-direct-decision-identifier-column-write/no-direct-decision-identifier-column-write
db.update(caseLawDecisions).set({ court: "Test court" });
