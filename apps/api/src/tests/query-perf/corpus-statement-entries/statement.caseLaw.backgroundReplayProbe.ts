import type { TransactionOf } from "@/api/db/scoped";
import { buildBackgroundReplayProbe } from "@/api/handlers/case-law/ingestion/replay";
import type { GatedTestDb } from "@/api/tests/gated-test-database";

import type { CorpusReadBudgetSeed } from "../corpus-seed";
import { REPLAY_PARSER_VERSION } from "../corpus-seed";
import type { CorpusStatementMeasurement } from "../measurement-definition";
import { QUERY_PERF_OWNER_DEADLINES } from "../owner-deadlines";

const measureBackgroundReplayProbe = (seed: CorpusReadBudgetSeed) =>
  ({
    budgetId: "statement.caseLaw.backgroundReplayProbe",
    build: (tx: TransactionOf<GatedTestDb>) =>
      buildBackgroundReplayProbe(tx, {
        sourceId: seed.replaySourceId,
        currentParserVersion: REPLAY_PARSER_VERSION,
        mode: "dry-run",
      }),
    // Caught up: the probe must rule out every row to answer.
    expectedRows: 0,
    ownerDeadlineMs:
      QUERY_PERF_OWNER_DEADLINES["statement.caseLaw.backgroundReplayProbe"],
  }) as const satisfies CorpusStatementMeasurement;

export default measureBackgroundReplayProbe;
