import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  group: "root-connection",
  id: "kept-transcript-deletions",
  capability: "Queueing kept provider transcripts for deletion",
  owner: ["apps/api/src/lib/dictation/kept-transcript-store.ts"],
  summary:
    "The denied deletion table records the id of each transcript a transcription provider kept, before the answer returns, and drops it once the provider confirms the delete. The scheduler's deletion task retries the rest on its own connection.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/lib/dictation/kept-transcript-store"],
    allowed: [
      {
        path: "apps/api/src/handlers/dictation/elevenlabs-provider.ts",
        reason:
          "Records a transcript ElevenLabs kept before the dictation answers, and drops it once its delete is confirmed.",
      },
      {
        path: "apps/api/src/lib/dictation/kept-transcript-store.db.test.ts",
        reason:
          "Exercises recording, dropping and the deletion task against the migrated table.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
