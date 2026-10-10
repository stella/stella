import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import nodePath from "node:path";

import { sha256Hex as hashSha256Hex } from "@stll/sha256/node";

import { ONLINE_VALIDATED_INDEX_NAMES } from "./online-migrations";

const MIGRATIONS_DIR = nodePath.resolve(import.meta.dir, "../../drizzle");
const ZERO_DURATION = /^'?0\s*(?:us|ms|s|min|h|d)?'?$/iu;
const CONCURRENT_INDEX_OPERATION =
  /^(?:(?:CREATE\s+(?:UNIQUE\s+)?|DROP\s+)INDEX\s+CONCURRENTLY|REINDEX\s+INDEX\s+CONCURRENTLY)\b/iu;
const IDENTIFIER = String.raw`(?:"(?:""|[^"])+"|[A-Za-z_][\w$]*)`;
const RELATION = String.raw`(?:${IDENTIFIER}\s*\.\s*)?${IDENTIFIER}`;
const CONCURRENT_IF_NOT_EXISTS = new RegExp(
  String.raw`\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\s+IF\s+NOT\s+EXISTS\s+(?<name>${RELATION})`,
  "giu",
);
const CONCURRENT_UNIQUE_CREATE = new RegExp(
  String.raw`\bCREATE\s+UNIQUE\s+INDEX\s+CONCURRENTLY(?<idempotent>\s+IF\s+NOT\s+EXISTS)?\s+(?<name>${RELATION})`,
  "giu",
);
const CONCURRENT_DROP = new RegExp(
  String.raw`\bDROP\s+INDEX\s+CONCURRENTLY\s+IF\s+EXISTS\s+(?<name>${RELATION})`,
  "giu",
);
const CONCURRENT_REINDEX = new RegExp(
  String.raw`\bREINDEX\s+INDEX\s+CONCURRENTLY\s+(?<name>${RELATION})`,
  "giu",
);
const TYPE_CHANGE =
  /^ALTER\s+TABLE\b[^;]*?\bALTER\s+(?:COLUMN\s+)?(?:(?:U&)?"(?:""|[^"])+"(?:\s+UESCAPE\s+'(?:''|[^'])*')?|[A-Z_\u0080-\u{10FFFF}][A-Z0-9_$\u0080-\u{10FFFF}]*)\s+(?:SET\s+DATA\s+)?TYPE\b/iu;
const TYPE_CHANGE_ANYWHERE =
  /\bALTER\s+TABLE\b[\s\S]*?\bALTER\s+(?:COLUMN\s+)?(?:(?:U&)?"(?:""|[^"])+"(?:\s+UESCAPE\s+'(?:''|[^'])*')?|[A-Z_\u0080-\u{10FFFF}][A-Z0-9_$\u0080-\u{10FFFF}]*)\s+(?:SET\s+DATA\s+)?TYPE\b/iu;
const TYPE_CHANGE_CLAUSE =
  /\bALTER\s+(?:COLUMN\s+)?(?:(?:U&)?"(?:""|[^"])+"(?:\s+UESCAPE\s+'(?:''|[^'])*')?|[A-Z_\u0080-\u{10FFFF}][A-Z0-9_$\u0080-\u{10FFFF}]*)\s+(?:SET\s+DATA\s+)?TYPE\b/giu;
const TRANSACTION_REVERSAL =
  /^(?:ABORT|ROLLBACK|SAVEPOINT|RELEASE\s+SAVEPOINT)\b/iu;
const TYPE_CHANGE_POLICY = {
  boundedRewrite: "stella-migration-safety: bounded-type-rewrite",
  metadataOnly: "stella-migration-safety: metadata-only-type-change",
} as const;
const TYPE_CHANGE_POLICY_STATEMENT = "STELLA_MIGRATION_SAFETY";
const CUSTOM_BOUNDED_TYPE_CHANGE_MIGRATIONS = new Set([
  // This conversion derives a 20-minute execution budget from pg_settings in
  // a DO block, which the statement scanner deliberately does not interpret.
  "20260729150000_timestamptz_everywhere/migration.sql",
]);
const ENTITY_FEATURE_GATE_MIGRATION =
  "20261009112500_entity_feature_row_gates/migration.sql";
// Migrations may execute only these exact reviewed DO blocks.
// Fingerprinting the complete statement makes comments, quoting tricks, and
// dynamically assembled commands unable to bypass migration safety checks.
const APPROVED_PROCEDURAL_STATEMENTS = new Set([
  "20261003122400_public_sanctions_reader/migration.sql:6cc0fbb1310629fc3b2e4e6ac47e0cdb64c91fed912aada50d7c9e4631dd3c05",
  // Validates matter memberships with a bounded existence read and a typed
  // constraint error. The static block changes no rows or timeout settings.
  "20261004001100_validate_matter_membership_organization_membership/migration.sql:b63282f9fdb50853ecdb93950ebd13f424a8a3ea142755f27ab5e8fbe60df69c",
  "20260429220500_global-search-unaccent/migration.sql:6eab967f03d9401b8f0791d81603f9540ac19fb872df5404f9b66ffff431d589",
  "20260429220500_global-search-unaccent/migration.sql:fe14433fc2fcc398e1d4efcd301f325a8f6e76705c158cd829b17fb9bb7f8797",
  "20260429220500_global-search-unaccent/migration.sql:2d8e7507916a4d6160ec2edebc72136c1b814cd55e2d766021ed5bbc25b5fd10",
  "20260429220500_global-search-unaccent/migration.sql:96584144b62646b9e7859c471fb271a920e6785cec5645cfd5182576f128141f",
  "20260504100000_chat-threads-organization-scope/migration.sql:56576f1e71c46aaba73327268f179c9fa6bafb717cffc7230cf6b2294c663e18",
  "20260510140000_document_rls_role_bootstrap/migration.sql:98cea54dd358cd650e49f706f9dc97990ab002e11ebead4736153aa8e40bbfe4",
  "20260510140000_document_rls_role_bootstrap/migration.sql:395c2e81d9db0b318f21466b273293c831b6715cc6d40f50db83cb39ff11c9c3",
  "20260510140000_document_rls_role_bootstrap/migration.sql:d7eda9dce4fb0c195bb88935168ca9fcf2307267adf33e3a08d697dae946fd5b",
  "20260510140000_document_rls_role_bootstrap/migration.sql:462404b62bc8a7440ce8e11aba1569886bc20b5c28c36ff2a88dc473f88dc45c",
  "20260516000000_case_law_ingestion_role/migration.sql:c3b2204559fb83fd696a107f42a35550c1ad035d337ce140010b63cb548e0a7b",
  "20260516000000_case_law_ingestion_role/migration.sql:7b418d2eab757c5c8d2105af6a199e9d7230ffaf213392eb0643bfb46018791a",
  "20260710173000_scalable_workspace_authorization/migration.sql:3b9057e5984cb105ddfdd2dc180e3e2f99655e12806fe59d7932b9bbdde7efea",
  "20260710173000_scalable_workspace_authorization/migration.sql:1fbe6a02081e270d5825863e873adb9007091344f41a9cc11296e90e9b370668",
  "20260710173000_scalable_workspace_authorization/migration.sql:162ceb09f52df96363765049625fc9fd03c2a5f00814c25c70ea50c7f043213d",
  "20260808007000_ai_memory_workspace_tenant_index/migration.sql:c2b0bcdf9034ce78b3f50acecf4254308deb21216601eaeb8aa8e0df675336ca",
  "20260808014000_legal_lists/migration.sql:6f7e9cfb9b2356f0c40c30909f6ea6c6155feb6d446921a5bc437f1913089935",
  "20260729150000_timestamptz_everywhere/migration.sql:1649cdb7d657ac6006bb5a1b76422b0b9be8fc0d7b8b338231fcd41b7778a7fe",
  "20260730090000_document_processing_mode/migration.sql:7de38e6645893bfca31e121c098e424c77a00aae03fd3400ebab26c6d6123437",
  "20260730120000_extracted_content_source_provenance/migration.sql:4094a6ecc995baccbc5cb4ef508627f026d7106e0b82b2848a594f3133a1bee0",
  "20260730120000_extracted_content_source_provenance/migration.sql:f7ed57df2f71621ff26baa780f24f69a652a3e125d29e8090057890a89477720",
  "20260730120000_extracted_content_source_provenance/migration.sql:2917a6d88b1415b2b3fa6e9e1bf547a19da3d350f85dc97e6200eb318bcfd378",
  "20260731200000_case_law_ingestion_retry_state/migration.sql:205b4776581f87ba60c7e8bd7b4d45ea50575dcc515360917b141e01850c2de7",
  "20261003122400_ingestion_role_set_grant/migration.sql:45cc20a960bc56f3c48bf74350bd0dc8795ad6668978bdab1260711ae27c5cb2",
  "20260731220000_case_law_redaction_fence/migration.sql:2802dc5388a64131da315915a25f9c0bbda6d72d6d7a2e7081aa03036dfd64d8",
  "20260731140000_matter_activity_provenance/migration.sql:f610b6a8787606f96741173e9cf7cc3a84ba23eb4ff892b39dbb56cec39a096b",
  "20260731170000_case_law_corpus_generation_backfill/migration.sql:a37f67d4e178fc403e75d871d17a31ee964754f87589f995571b71a1d15ca144",
  "20260731170000_case_law_corpus_generation_backfill/migration.sql:a12d358dc0bc37698b3cd6a8ff5c4d0355050db0117f7671f574e0bfdfd282b6",
  "20260731170000_case_law_corpus_generation_backfill/migration.sql:75b21e27d35379209cc63a9dbf5fc1b6ad21a2945cf4cc0788f9e5a335aad806",
  "20260731170000_case_law_corpus_generation_backfill/migration.sql:d12b8d4de8e6436dfebb1177277fbc1dbbf4482afb429b38ae599c14350cf8c5",
  "20260731170000_case_law_corpus_generation_backfill/migration.sql:83417da56687155c11d3f0c999608af4a6abcdd78162f2d0a485e33ff40f9b7f",
  "20260731170000_case_law_corpus_generation_backfill/migration.sql:e395b6cbdc652a7d70833c571587cda7e4dba86323a19a1bcfe67874a90afec1",
  "20260731170000_case_law_corpus_generation_backfill/migration.sql:938744a8ba4d42a4fc2f6738ef8060d25b4cce08e0f88c393b9ae0a30d046984",
  "20260731170000_case_law_corpus_generation_backfill/migration.sql:bd1d14e9b83389dfc908098d23d61c93c1bc8c3a12a06fb8d090c7aa6de698e9",
  "20260731170000_case_law_corpus_generation_backfill/migration.sql:156772a852d5e4193fc68e5effb6881b8f9f022435c91882f16d5ad642c88993",
  "20260801140000_report_export_result_field/migration.sql:f6ad29cee9c49e07aad487cf5a8d5f32838b63a1cfa8f92a071a4f0afc277a5d",
  "20260801120000_case_law_source_ingestion_lease/migration.sql:c8cddc8405b46385e7159c745ccb8c095e88e67a6c4ff0a2d6bcd1cd124a2b63",
  "20260805100000_ocr_exports/migration.sql:a119e3e1f41e55e853ae907e400426de2443dd1575f675c10e705b945c6e0e66",
  // Adds the chat reasoning-effort CHECK only when it is absent. The body is
  // static DDL; the conditional makes a partially applied migration retryable.
  "20260808003000_chat_reasoning_effort/migration.sql:871dd7588123b5ea2a092acac856c0427e4cf8673b8494bc94cf0a6dbd6cfd0f",
  // Refuses to re-order the corpus-index rebuild's cursor while a rebuild is
  // in flight. Reads one small checkpoint table and raises; it writes nothing,
  // takes no lock beyond the read, and stopping the release is the intended
  // outcome, since the two orders cannot share one cursor slot.
  "20260817150000_corpus_generation_date_walk/migration.sql:06821016b65f9c0e7ab643794da37f29616a0ccbef91df3df8b1806197f5ac8c",
  // Adds the decision-date bounds CHECK NOT VALID only when it is absent. The
  // body is static DDL; the conditional makes the file retryable after the
  // VALIDATE that follows it outside the migrator transaction.
  "20260818090000_case_law_decision_date_bounds/migration.sql:31f2786a7f7aed2d2e55bd3161acad6ad49e606ec1bc75e9235de07cdadd96e0",
  // Retries the decision-date constraint swap on lock_not_available with
  // waits that lengthen in tiers: metadata-only DDL on a table the corpus
  // workers write to without pause, in transactions that outlast a short
  // wait.
  "20260902100000_case_law_decision_date_ceiling/migration.sql:d799f99eb97532f1f3819aae3e325fcc65d123f2a3bc7b98d4e9f41e417f8491",
  // The same tiered retry around the swap to a per-jurisdiction floor.
  "20260927200300_case_law_decision_date_floor_by_jurisdiction/migration.sql:c300312bf7d8af42fb76119b2f09fd4a372d9d836809e69198f5de811b2bb4f4",
  // The same tiered retry around adding the court id and its NOT VALID check,
  // refusing to run while a USA row lacks an id.
  "20261002120400_case_law_decision_court_id/migration.sql:fdc516be9eef4487a1cb269ae34793d2ed281e9ae55aeb91f6305005c5d6f3b5",
  // The same tiered retry around adding the primary reference type column
  // and its NOT VALID check.
  "20261003121000_case_law_decision_case_number_type/migration.sql:83fc403c99c6f705c47e3b4d029ad695bae40385a43a0ae817425992b0547627",
  // The same tiered retry around adding the nullable case-file key column.
  "20261003123300_case_law_decision_docket_family_key/migration.sql:7b46b61397d41a9d56b74a1076485cc682123ff373c8d9893b2b87918c4c8b48",
  // Acquires the two hot corpus tables in writer order before installing the
  // citation-count triggers. The static body retries only lock_not_available
  // under a bounded statement budget and changes no rows.
  "20260911150000_statute_citation_counts/migration.sql:e82e24a5004eec55ebf7ec2b84be5e201e227a8cacda299b4c612aab0b703ed1",
  // Acquires legislation_documents before adding the payload revision column
  // and its triggers. The same static retry body: only lock_not_available,
  // under a bounded statement budget, changing no rows.
  "20260926150000_legislation_payload_revision/migration.sql:e0b0bda4c5afe7b5e214268b05745e54eda8580496a5d5bb904349e2e0d4ab9b",
  // Acquires legislation_documents and legislation_sources in writer order
  // before the expression identity columns, CHECKs and triggers. Static body:
  // retries only lock_not_available, each attempt waiting at most one second
  // and a failed attempt releasing what it took, a bounded number of times
  // under a bounded statement budget, changing no rows.
  "20261003120000_legislation_expression_identity/migration.sql:290e5e1b0593059ef05e22ec0e35f168abd9d235e7aa933143b676b6a6726a7c",
  // Acquires the decisions and the provision rows in writer order before the
  // provision span columns, the state foreign key and the enqueue trigger.
  // Same static retry body as above; it changes no rows.
  "20260926160000_case_law_provision_extraction_state/migration.sql:6b8802ea79fb93234ca5911888421bca3310ac7b718f76df049de02bc3b3601c",
  // Fails the Better Auth cutover before any constraint or index state is
  // committed when the trusted issuer backfill is incomplete. The static body
  // performs one bounded existence read and raises; it executes no dynamic SQL.
  "20260825220000_better_auth_17_constraints/migration.sql:4c1e0d5fdbb50e29863c067586c405148beb02f76a2af8ebbced851a866abc13",
  // Refuses to seed a legacy serving route over an existing generation bound
  // to a different cluster. The static body reads two primary-key rows and
  // raises; it executes no dynamic SQL.
  "20260826004000_corpus_index_serving_generation/migration.sql:2a9afa811510709034b847b4ecdcf3f3a78d5c499cb4f584ac6ef0e9410d8419",
  // Refuses to finish the reader cutover unless both families have a serving
  // generation. The static body performs one bounded existence read over
  // corpus_index_generations and raises; it executes no dynamic SQL.
  "20260826004000_corpus_index_serving_generation/migration.sql:3cf1be3c49aad9abb99793f955b1c60e6d4fc5926ca1538e9ae2419a14242738",
  // Adds the cleanup-status CHECK only when absent. The body is static DDL;
  // the conditional makes a partially applied migration retryable.
  "20260830150000_workspace_reference_cleanup_indexes/migration.sql:157817473ab2cf147be3836c532ca148079553e488ae4df0bdb9ae19ecaa32e2",
  // Add each supplements foreign key and CHECK only when absent. The bodies
  // are static DDL; the conditional makes a re-applied migration a no-op.
  "20260924100000_case_law_decision_supplements/migration.sql:784ee86bc5f375503326b7b432485d292dc5bafbe6d5c1ea1b63f7a55b81ba61",
  "20260924100000_case_law_decision_supplements/migration.sql:c164fa270ee521594466ebf9458f712658d300a1e83106f6c866698c9f407642",
  "20260924100000_case_law_decision_supplements/migration.sql:d6003f318eb66d4f93b252378c7e0e97a397a8827a7568ceb6036e9043784d0f",
  "20260924100000_case_law_decision_supplements/migration.sql:db38e6608b819f8b1bbc93274349ab1b5212a352dd36ce6b84294983dfac267d",
  // Confirms that only the expected application-owned relations are present
  // and that their owners can run the maintenance functions. This catalog
  // read raises on mismatch and changes no data or schema.
  `${ENTITY_FEATURE_GATE_MIGRATION}:b46a4954165ddc68ba7dbf4d5a1fb533356a5559be76dd75c90186d50e74ea58`,
  // Creates the constrained non-login maintenance role only when absent, then
  // verifies its attributes, memberships, and ownership boundaries.
  `${ENTITY_FEATURE_GATE_MIGRATION}:c8f82c7c02b0c29a54777add6909f0c2f546b41f26f44c648d5e23a2330ceb3c`,
]);

// These exact fingerprints cover the 94 generated catalog lookups plus their
// NOT VALID check additions. Any SQL change needs a fresh review; adding these
// checks avoids scanning existing rows.
const APPROVED_ENTITY_FEATURE_GATE_CONSTRAINTS = new Set([
  "5645745a8577560f4c428a6c2bd523c66d776759aea869bf261b86a1ac346751",
  "6ce421af8d6beeeba56ef9f6cd87271696093904100a618a91b23c33b59bdfcc",
  "a8d512bc38b7a1888c799e16b5cbbe3f0d04c4a1a7b3fe0c8d5d94ca8151e8bc",
  "93053ee1fa468b14eb8e8e22c74aad4cb2d831f9d3a6ad2b676c547a65d485a0",
  "24dea639df4702a9c0acdc7c024098634cc38bcf8e3f78453604d9b2b3efe563",
  "e98dc82f92411654f247c7c92271071eccb194f391bd6e2ace5937c66ec62920",
  "5a31e0c22d1d02130f329c75d2db52568683bcc50de99d73ad78e5e110d48092",
  "053fb0fd0f22675bc30e6a57520962a0f981609d2ac7f41b71b35186b7da529e",
  "823f19ad06e2623ce6c5c2a762c105adb009491536e0de6280832cb9e5e6acc6",
  "ee4a9cdebc1f6a29a2aaac7e9f129ea58f0f1db317c5d583e1af0f6b8e1f0233",
  "9e55c7239cbb0bc01e1608678d1fe7b7ff9dae05ba4f3a3bd28188cb58ddb607",
  "9f7c642b388e366b3497a48349d5f1d7219aebaca510a782b4da6e7b468da3b2",
  "29d9e40a806251659c72f513e093909c215d95f23f8f71f9d1ba8b40ed79841e",
  "729655f2717e8cd184c368cd4f2143bb925d02804fd374a85d2efd15d4b046e8",
  "02e63bdf829f78838f624a811fa962ac9448cc9305c18e4bed03ec44791b3500",
  "758ee02d1b87ba0c226aa525a710b2796c88d9c393658e1df597ff59867fba83",
  "afe023e604d3efc5ceddbb93d2b0d82bf9f406e47c87b4388a219a8d455824d1",
  "27f020c82ddc837e2052448b69902138a9697cc2f6fd9c2dc9d6637d4c4c9cb1",
  "6af897f78e2dacc81296dce02728c43b59aaff9e107f64fd5569c2ae57bf3d10",
  "0330edb7a8b23c92ae4742210f1d75617fcc6b9ec0f3e4a870324d0a4cd99a7d",
  "4137e78919f2f17a46d635cc7007ebf486597f0d397de0f07a3e7dbf4613d211",
  "fa6ea88d7d9e78ed08510f433ae0d3a891d9f887193a905d0968dd22e1094c0f",
  "55f3b32767ee07c4f63eab8a0599f6ab47f90e20c0ce1f5331bf697c16b3a1c2",
  "6b2fdb088d52d4738a61807e976346ec7e99fc26c97241b38ed51425823c9abe",
  "8e936bc0a4e749ec5573c41a744c12d0273f7dd5788527f8dd3365d7bfb9733c",
  "26acc11e459396faa25348d20ea3af88750b8a55788c86a75a12b7a5d599aa1e",
  "a89e580a9b04dad1960c166645288031913f07f9a0691e0892b39d83a5d733a4",
  "f1ea10cbb7894675ca6e31c98842e855bd8291789b033df7ba6e97841f27f0f4",
  "fa51cbbcf1abcdcfb6c6509337aa5868f8c045f0b238e6559e9d03c547599927",
  "0f86824827ac4fa1acfeb2304f45f35297fb46f9d33ef502b271591d78f1e535",
  "74e0e9387811e915cdf666a74418767381d9874b84d29e09fb77211af8912f5b",
  "e94f9ddf497c113684555b51da8bb636fdd46da044419c9132eca067fac06244",
  "eab9c812df00f77cf38aee7d22ca2283562607c6080fc8761c2f71a1e908ff2d",
  "385f3d8685f9536a65d8f3e96b7960d48a0db0dc567e0968a01a4d31a5ca99af",
  "3f20849879ccbe4a0b72fdc34b11ac853efdee476c57aef432187e9b42866f28",
  "c943fc8e4434cc615153b4369d7bb6d06176b0938f27ae6232d4225cde320128",
  "ab3c5dcfcaacfb758771c2c7cb26b121da66857292a0e6d3886a9385319fa457",
  "a79e09d25d750f14c261f5b2124e9b6eb2a83521ec12ac060a4e293a703d7e55",
  "12f6f2fce3d4702bf1326cddcc65691a986a0f36f12f148620927d4400ed5571",
  "c414f6e240b30026fe976a7831faccb7ed580bca084787ecdc71d59429d450f5",
  "a3dc1532250fd4a95434f50c150531b1b23e15de9aeac5c5e0b0371a11118b04",
  "58fc31ce5c1f359ede3dbf41fa0fef7564dda4566ad3ec69b8cb8dfe6596710a",
  "c02095b62ae94dbd379385fa5b2f00e6d0e1e3091b405c92929b14538fe1241d",
  "0fe45738ebe57a0cabb4a304326de27101b50a6dc516519d325d2f616a709920",
  "6ba06d6917ffcb4ade88aebe5a371a55bc4a6b873e548846f606fc59af5d82a5",
  "d5170087f1fbc62ba2897d1245b8fa4a49e45911bb9c5536caed8a54eae8399e",
  "4015525d6c879c62ce56455f76178933d8a322c16b17de049b9416efb81e16d7",
  "e453db9219c6d2427cc2da5d14bf1aee71ed9e9fc058a573c96d4ab2cb632132",
  "4ccc6fcc4b719fd83e9f4445bd584cdd3852a4cc1c799799a61a10a53945ee1e",
  "2f4ba225c438bc97e3cd1a890a2708fb26226fb957ce5e803db7347fe3cd1aad",
  "6e3d022167002441764778e68fa48e8ec26e742e2a2c9eaf1476a12753c106f6",
  "c1b8f4a65916b58d2dad99c08c6596527c070efcb183febd68e618810611a684",
  "9cd483d65a17f26d19ec09d60cffc1fe0815834a7d6e2917339d225cb14c7f1f",
  "397901955b567c2d2f00d3770fd71d70043fca68277ad2d3714cb7a087cf13e2",
  "cb0574ef509e8963d5d0b3e3ef34e4c971ca78e9907cebe1031a5285a644cb70",
  "3a958e6ecf746aca652dc85bdf52ceb5426058de1e73b3d1ebecb1aef081c7fa",
  "be228214928f3581f654ff187887ad9475662ddd247157b0495a9890851919c5",
  "9101b13c60401a0b50e38548d764d9f0a7a0d65b4cc18f45172e8827e862bad9",
  "fb139bfa5a35dbe4b1102ae276aeb4eb586f6dcab257ac2a100885e5c7fefce4",
  "a2889a739bc3c9688b535f126182c645a6465ba05e0af8b47a8201afc6bd88d0",
  "02d2370129f9105c563a938af68959e143d118dafde571b5caf3b379bb6f2e7f",
  "c0ec23a70f4254eb2f7851a98291e4eb481d59edc1465b848f5041e69a6c8244",
  "6c467770a1ca6f884660f92dea6cae5a513790162e97c127f7285406a99753d2",
  "6742b9efff570f65ef5c2c0c1d6e750a8f06a3367d4f40ccaff596f5b25409df",
  "81d9d5bec17a4ff9b7ad3734121072dd89c276b504bdc62ed91d63212124a418",
  "558260aaa96b94117d3499a60eb2e31faefe33b7a98c20b2d16576fc189e88e6",
  "1b7c50e28e5a6c2a85a94cf9ce186f1e59e962bd278577c4ec36199530f3165e",
  "cb8041be4d675f11b254ea7896ef0f42369a2f2dd94dbcf773c9c316b42ed2b6",
  "88237bad776ed0b40b7b9eb83ed5525f5d4794fd74804cc56713eca28eef1ebc",
  "0b4545ba2b965ab25218501beacac9a298a3f4cf142156794598aec271df8a7d",
  "ac6dfe27a1a315e30be6753d9bd377aadd985180f5fca4aa885506765e37cfa9",
  "a382d770ba7a61e26fe7e610deb1f5d708bab9c4b4213fb71872ffeddcd4d0bf",
  "567bae2b3eb8da0ddc5653f0f28ac78b4854257e780ba3dd2b9e732a1811f2a8",
  "396b24679aabe260e32a7cc988b49273a70522f820562e04d05f3d572ee2b490",
  "f8f594079170aafed819c0d596cf563a523d06a75f07506242652280dc121e51",
  "b3d68b06a3453b2c681566bf4a29ee996c8a353583f42024672717fc00ba2805",
  "de26038efbe4dbd86f1974b9790eab7543b75afb521b8ae11dd5b3ddb72c2626",
  "6fc6cfb9a3a60e063fa1b01260b4a7f885474664cf8ade9d8a02c65bf020ad97",
  "a3efb93c1bf72236ab0b0ed8b51e66397abc2c41ecee75f22083377adb901a58",
  "602463a45173e5fbbdbc249a3e2559c52d2021c7e818b990724ab41daf3286ec",
  "6c9b17af2cbf6566b1957601d5142866b8e14c2f5c5016917dd554dd426caeb8",
  "a9fba5c4a179412bee74fc54aa61a2a343b879c4a293d0ebd297fbdcd98cde6a",
  "d8b2791d29ee71ba30a2f86ef756856198f160f18973f562167f3a974ee4ca9f",
  "735d6b253d0abbfa906645e6a516217cd37f08d34bd2530afc8e9192e268a377",
  "607726d9f4b283fff200c2b5a319bde9ba7430b23d8331addfce617fba6ab2ca",
  "e704ce78227747c42a0bc5804ddc1e66c1b1d081cfaea10578f24201c7056a25",
  "81a0430d7771d0191da592e837c45a2a5e880d7045917e09863cb0c0d5afce84",
  "92e7dca3a2cc3c80eea09a6ef0ba79853cdcfe6b1073ac4f04e8cf3b900627e9",
  "491a6067dcb2b4419b6fa4d52e42ade2316550286a68be55c87c2cf206b6158b",
  "26b11b91150de5c719642adc8292d389dd8529b80293d82d27433f3eb89e9463",
  "be4ed040eb24cfe14832c3ebf929222d78ed074c0dee385d364f6d1c42da12a8",
  "f3ec22509caf88f4056fb8f87634d17a2c63b0085becfd6e2c920f2a0a7ba059",
  "57c4e63efedc8e739e26012d25ca15dbc3e5c118abf33b85e5db536d41293994",
  "ff116687fff25989df2b68bdaf6fd962b122ec66e7d06c08fac222b70a8f0074",
]);
type TimeoutState = "bounded" | "unbounded" | "unset";
type TypeChangePolicy = "boundedRewrite" | "metadataOnly";
type SqlQuote = {
  backslashEscapes: boolean;
  character: '"' | "'";
};
type TimeoutUpdate =
  | {
      type: "checkpoint";
      name: "lock" | "statement";
    }
  | {
      type: "restore";
      name: "lock" | "statement";
    }
  | {
      type: "set";
      name: "lock" | "statement";
      scope: "local" | "session";
      state: TimeoutState;
    }
  | {
      type: "reset";
      name: "all" | "lock" | "statement";
    }
  | {
      type: "preserve";
      name: "lock" | "statement";
      scope: "local" | "session";
    };

const classifyTimeout = (value: string): TimeoutState => {
  if (ZERO_DURATION.test(value)) {
    return "unbounded";
  }
  if (/^'?[1-9][0-9]*\s*(?:us|ms|s|min|h|d)?'?$/iu.test(value)) {
    return "bounded";
  }
  return "unset";
};

const POSTGRES_IDENTIFIER_CONTINUATION = /[A-Z0-9_$\u0080-\u{10FFFF}]/iu;

const dollarQuoteDelimiterAt = (source: string, index: number) => {
  if (POSTGRES_IDENTIFIER_CONTINUATION.test(source[index - 1] ?? "")) {
    return undefined;
  }
  return /^\$(?:[A-Z_\u0080-\u{10FFFF}][A-Z0-9_\u0080-\u{10FFFF}]*)?\$/iu
    .exec(source.slice(index))
    ?.at(0);
};

const sqlQuoteAt = (
  source: string,
  index: number,
  character: '"' | "'",
): SqlQuote => {
  const prefix = source[index - 1] ?? "";
  const beforePrefix = source[index - 2] ?? "";
  const isEscapeString =
    character === "'" &&
    prefix.toLowerCase() === "e" &&
    !POSTGRES_IDENTIFIER_CONTINUATION.test(beforePrefix);

  return { backslashEscapes: isEscapeString, character };
};

const policyStatementForComment = (comment: string) => {
  if (comment.includes(TYPE_CHANGE_POLICY.metadataOnly)) {
    return `${TYPE_CHANGE_POLICY_STATEMENT} metadataOnly;`;
  }
  if (comment.includes(TYPE_CHANGE_POLICY.boundedRewrite)) {
    return `${TYPE_CHANGE_POLICY_STATEMENT} boundedRewrite;`;
  }
  return "";
};

const stripSqlComments = (source: string) => {
  let result = "";
  let index = 0;
  let blockCommentDepth = 0;
  let dollarQuoteDelimiter: string | undefined;
  let quote: SqlQuote | undefined;

  while (index < source.length) {
    const character = source[index] ?? "";
    const nextCharacter = source[index + 1] ?? "";

    if (blockCommentDepth > 0) {
      if (character === "/" && nextCharacter === "*") {
        blockCommentDepth += 1;
        index += 2;
      } else if (character === "*" && nextCharacter === "/") {
        blockCommentDepth -= 1;
        index += 2;
      } else {
        if (character === "\n") {
          result += "\n";
        }
        index += 1;
      }
      continue;
    }

    if (dollarQuoteDelimiter) {
      if (source.startsWith(dollarQuoteDelimiter, index)) {
        result += dollarQuoteDelimiter;
        index += dollarQuoteDelimiter.length;
        dollarQuoteDelimiter = undefined;
      } else {
        result += character;
        index += 1;
      }
      continue;
    }

    if (quote) {
      result += character;
      if (quote.backslashEscapes && character === "\\" && nextCharacter) {
        result += nextCharacter;
        index += 2;
      } else if (
        character === quote.character &&
        nextCharacter === quote.character
      ) {
        result += nextCharacter;
        index += 2;
      } else {
        if (character === quote.character) {
          quote = undefined;
        }
        index += 1;
      }
      continue;
    }

    if (character === "-" && nextCharacter === "-") {
      const newlineIndex = source.indexOf("\n", index + 2);
      const commentEnd = newlineIndex === -1 ? source.length : newlineIndex;
      const policyStatement = policyStatementForComment(
        source.slice(index + 2, commentEnd),
      );
      if (policyStatement) {
        result += `\n${policyStatement}\n`;
      }
      if (newlineIndex === -1) {
        break;
      }
      result += "\n";
      index = commentEnd + 1;
      continue;
    }
    if (character === "/" && nextCharacter === "*") {
      result += " ";
      blockCommentDepth = 1;
      index += 2;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = sqlQuoteAt(source, index, character);
      result += character;
      index += 1;
      continue;
    }
    if (character === "$") {
      const delimiter = dollarQuoteDelimiterAt(source, index);
      if (delimiter) {
        dollarQuoteDelimiter = delimiter;
        result += delimiter;
        index += delimiter.length;
        continue;
      }
    }

    result += character;
    index += 1;
  }

  return result;
};

const splitSqlStatements = (source: string) => {
  const statements = [];
  const sql = stripSqlComments(source);
  let current = "";
  let index = 0;
  let dollarQuoteDelimiter: string | undefined;
  let quote: SqlQuote | undefined;

  while (index < sql.length) {
    const character = sql[index] ?? "";
    const nextCharacter = sql[index + 1] ?? "";

    if (dollarQuoteDelimiter) {
      if (sql.startsWith(dollarQuoteDelimiter, index)) {
        current += dollarQuoteDelimiter;
        index += dollarQuoteDelimiter.length;
        dollarQuoteDelimiter = undefined;
      } else {
        current += character;
        index += 1;
      }
      continue;
    }

    if (quote) {
      current += character;
      if (quote.backslashEscapes && character === "\\" && nextCharacter) {
        current += nextCharacter;
        index += 2;
      } else if (
        character === quote.character &&
        nextCharacter === quote.character
      ) {
        current += nextCharacter;
        index += 2;
      } else {
        if (character === quote.character) {
          quote = undefined;
        }
        index += 1;
      }
      continue;
    }

    if (character === "'" || character === '"') {
      quote = sqlQuoteAt(sql, index, character);
      current += character;
      index += 1;
      continue;
    }
    if (character === "$") {
      const delimiter = dollarQuoteDelimiterAt(sql, index);
      if (delimiter) {
        dollarQuoteDelimiter = delimiter;
        current += delimiter;
        index += delimiter.length;
        continue;
      }
    }
    if (character === ";") {
      if (current.trim()) {
        statements.push(current.trim());
      }
      current = "";
      index += 1;
      continue;
    }

    current += character;
    index += 1;
  }

  if (current.trim()) {
    statements.push(current.trim());
  }

  return statements;
};

const parseTimeoutUpdate = (statement: string): TimeoutUpdate | undefined => {
  if (/^DISCARD\s+ALL$/iu.test(statement)) {
    return { type: "reset", name: "all" };
  }

  const checkpointGroups =
    /^(?:SELECT|PERFORM)\s+(?:pg_catalog\.)?set_config\(\s*'stella\.migration_(?<name>statement|lock)_timeout'\s*,\s*(?:pg_catalog\.)?current_setting\(\s*'(?<source>statement|lock)_timeout'\s*\)\s*,\s*false\s*\)$/iu.exec(
      statement,
    )?.groups;
  const checkpointName = checkpointGroups?.["name"];
  if (
    (checkpointName === "lock" || checkpointName === "statement") &&
    checkpointGroups?.["source"] === checkpointName
  ) {
    return { type: "checkpoint", name: checkpointName };
  }

  const restoreGroups =
    /^(?:SELECT|PERFORM)\s+(?:pg_catalog\.)?set_config\(\s*'(?<name>statement|lock)_timeout'\s*,\s*(?:pg_catalog\.)?current_setting\(\s*'stella\.migration_(?<source>statement|lock)_timeout'\s*\)\s*,\s*false\s*\)$/iu.exec(
      statement,
    )?.groups;
  const restoreName = restoreGroups?.["name"];
  if (
    (restoreName === "lock" || restoreName === "statement") &&
    restoreGroups?.["source"] === restoreName
  ) {
    return { type: "restore", name: restoreName };
  }

  const setGroups =
    /^SET\s+(?:(?<scope>SESSION|LOCAL)\s+)?(?<name>statement|lock)_timeout\s*(?:(?:=|TO)\s*(?<value>.+)|FROM\s+CURRENT)$/iu.exec(
      statement,
    )?.groups;
  const setName = setGroups?.["name"];
  if (setName === "lock" || setName === "statement") {
    const scope =
      setGroups?.["scope"]?.toLowerCase() === "local" ? "local" : "session";
    if (!setGroups?.["value"]) {
      return { type: "preserve", name: setName, scope };
    }
    if (/^DEFAULT$/iu.test(setGroups["value"])) {
      return scope === "session"
        ? { type: "reset", name: setName }
        : { type: "preserve", name: setName, scope };
    }
    return {
      type: "set",
      name: setName,
      scope,
      state: classifyTimeout(setGroups["value"]),
    };
  }

  const setConfigGroups =
    /^(?:SELECT|PERFORM)\s+(?:pg_catalog\.)?set_config\(\s*'(?<name>statement|lock)_timeout'\s*,\s*(?<value>'(?:''|[^'])*')\s*,\s*(?<local>true|false)\s*\)$/iu.exec(
      statement,
    )?.groups;
  const setConfigName = setConfigGroups?.["name"];
  if (setConfigName === "lock" || setConfigName === "statement") {
    return {
      type: "set",
      name: setConfigName,
      scope:
        setConfigGroups?.["local"]?.toLowerCase() === "true"
          ? "local"
          : "session",
      state: classifyTimeout(setConfigGroups?.["value"] ?? ""),
    };
  }

  const resetName =
    /^RESET\s+(?<name>ALL|statement_timeout|lock_timeout)$/iu.exec(statement)
      ?.groups?.["name"];
  if (resetName?.toLowerCase() === "all") {
    return { type: "reset", name: "all" };
  }
  if (resetName?.toLowerCase() === "lock_timeout") {
    return { type: "reset", name: "lock" };
  }
  if (resetName?.toLowerCase() === "statement_timeout") {
    return { type: "reset", name: "statement" };
  }

  return undefined;
};

const parseTypeChangePolicy = (
  statement: string,
): TypeChangePolicy | undefined => {
  const policy = new RegExp(
    `^${TYPE_CHANGE_POLICY_STATEMENT}\\s+(boundedRewrite|metadataOnly)$`,
    "u",
  )
    .exec(statement)
    ?.at(1);
  if (policy === "boundedRewrite" || policy === "metadataOnly") {
    return policy;
  }
  return undefined;
};

const isCustomStatementBudget = (statement: string) =>
  /^DO\s+\$\$\s*DECLARE\s+current_ms\s+integer\s*;\s*BEGIN\s+SELECT\s+setting::integer\s+INTO\s+current_ms\s+FROM\s+pg_settings\s+WHERE\s+name\s*=\s*'statement_timeout'\s*;\s*IF\s+current_ms\s*=\s*0\s+OR\s+current_ms\s*<\s*1200000\s+THEN\s+PERFORM\s+set_config\(\s*'statement_timeout'\s*,\s*'20min'\s*,\s*false\s*\)\s*;\s*END\s+IF\s*;\s*END\s*\$\$$/iu.test(
    statement,
  );

const isUnapprovedProceduralStatement = (
  relativePath: string,
  statement: string,
) => {
  if (!/^DO\b/iu.test(statement)) {
    return false;
  }
  if (
    CUSTOM_BOUNDED_TYPE_CHANGE_MIGRATIONS.has(relativePath) &&
    isCustomStatementBudget(statement)
  ) {
    return false;
  }

  const hash = hashSha256Hex(statement);
  if (
    relativePath === ENTITY_FEATURE_GATE_MIGRATION &&
    APPROVED_ENTITY_FEATURE_GATE_CONSTRAINTS.has(hash)
  ) {
    return false;
  }
  return !APPROVED_PROCEDURAL_STATEMENTS.has(`${relativePath}:${hash}`);
};

type ConcurrentTimeoutState = {
  concurrentBlockOpen: boolean;
  lockTimeout: TimeoutState;
  lockTimeoutCheckpoint: TimeoutState | undefined;
  lockTimeoutRequiresRestore: boolean;
  statementTimeout: TimeoutState;
  statementTimeoutCheckpoint: TimeoutState | undefined;
  statementTimeoutRequiresRestore: boolean;
  statementTimeoutRestored: boolean;
};

const applyConcurrentTimeoutUpdate = ({
  relativePath,
  state,
  timeoutUpdate,
  violations,
}: {
  relativePath: string;
  state: ConcurrentTimeoutState;
  timeoutUpdate: TimeoutUpdate | undefined;
  violations: string[];
}): void => {
  if (timeoutUpdate?.type === "checkpoint") {
    if (timeoutUpdate.name === "statement") {
      state.statementTimeoutCheckpoint = state.statementTimeout;
    } else {
      state.lockTimeoutCheckpoint = state.lockTimeout;
    }
    return;
  }
  if (timeoutUpdate?.type === "restore") {
    const checkpoint =
      timeoutUpdate.name === "statement"
        ? state.statementTimeoutCheckpoint
        : state.lockTimeoutCheckpoint;
    if (checkpoint === undefined) {
      violations.push(
        `${relativePath}: ${timeoutUpdate.name} timeout restore lacks a checkpoint`,
      );
      return;
    }
    if (timeoutUpdate.name === "statement") {
      state.statementTimeout = checkpoint;
      state.statementTimeoutRequiresRestore = false;
    } else {
      state.lockTimeout = checkpoint;
      state.lockTimeoutRequiresRestore = false;
    }
    return;
  }
  if (timeoutUpdate?.type === "set" && timeoutUpdate.scope === "session") {
    if (timeoutUpdate.name === "statement") {
      state.statementTimeout = timeoutUpdate.state;
      state.statementTimeoutRequiresRestore =
        timeoutUpdate.state === "unbounded";
    } else {
      state.lockTimeout = timeoutUpdate.state;
      state.lockTimeoutRequiresRestore = timeoutUpdate.state !== "bounded";
    }
    return;
  }
  if (timeoutUpdate?.type === "reset") {
    if (timeoutUpdate.name === "all" || timeoutUpdate.name === "statement") {
      state.statementTimeout = "unset";
    }
    if (timeoutUpdate.name === "all" || timeoutUpdate.name === "lock") {
      state.lockTimeout = "unset";
      if (state.concurrentBlockOpen) {
        state.lockTimeoutRequiresRestore = true;
      }
    }
  }
};

const enforceConcurrentRestoreProtocol = ({
  isConcurrentOperation,
  isProtocolBridge,
  isStatementRestore,
  relativePath,
  state,
  violations,
}: {
  isConcurrentOperation: boolean;
  isProtocolBridge: boolean;
  isStatementRestore: boolean;
  relativePath: string;
  state: ConcurrentTimeoutState;
  violations: string[];
}): void => {
  if (!state.concurrentBlockOpen) {
    return;
  }
  if (isStatementRestore) {
    state.statementTimeoutRestored = true;
  }
  if (state.statementTimeoutRestored && !state.lockTimeoutRequiresRestore) {
    state.concurrentBlockOpen = false;
    return;
  }
  if (!isConcurrentOperation && !isStatementRestore && !isProtocolBridge) {
    violations.push(
      `${relativePath}: timeouts are not restored immediately after concurrent index operations`,
    );
    state.concurrentBlockOpen = false;
  }
};

const collectUnsafeConcurrentTimeouts = (
  relativePath: string,
  source: string,
) => {
  const violations = [];
  const statements = splitSqlStatements(source);
  const state: ConcurrentTimeoutState = {
    concurrentBlockOpen: false,
    lockTimeout: "unset",
    lockTimeoutCheckpoint: undefined,
    lockTimeoutRequiresRestore: false,
    statementTimeout: "unset",
    statementTimeoutCheckpoint: undefined,
    statementTimeoutRequiresRestore: false,
    statementTimeoutRestored: false,
  };

  for (const statement of statements) {
    if (isUnapprovedProceduralStatement(relativePath, statement)) {
      violations.push(
        `${relativePath}: procedural migration statement is not approved`,
      );
      continue;
    }
    const timeoutUpdate = parseTimeoutUpdate(statement);
    const isConcurrentOperation = CONCURRENT_INDEX_OPERATION.test(statement);
    const isUnsupportedTransactionReversal =
      TRANSACTION_REVERSAL.test(statement);
    const isStatementRestore =
      (timeoutUpdate?.type === "restore" &&
        timeoutUpdate.name === "statement" &&
        state.statementTimeoutCheckpoint !== undefined) ||
      (timeoutUpdate?.type === "set" &&
        timeoutUpdate.name === "statement" &&
        timeoutUpdate.scope === "session" &&
        timeoutUpdate.state === "bounded");
    const isProtocolBridge =
      (timeoutUpdate?.type === "set" && timeoutUpdate.name === "lock") ||
      (timeoutUpdate?.type === "restore" && timeoutUpdate.name === "lock") ||
      (timeoutUpdate?.type === "reset" &&
        (timeoutUpdate.name === "all" || timeoutUpdate.name === "lock")) ||
      /^(?:BEGIN|COMMIT)$/iu.test(statement);

    if (isUnsupportedTransactionReversal) {
      violations.push(
        `${relativePath}: timeout safety does not support transaction reversal`,
      );
    }

    applyConcurrentTimeoutUpdate({
      relativePath,
      state,
      timeoutUpdate,
      violations,
    });
    enforceConcurrentRestoreProtocol({
      isConcurrentOperation,
      isProtocolBridge,
      isStatementRestore,
      relativePath,
      state,
      violations,
    });

    if (timeoutUpdate || isUnsupportedTransactionReversal) {
      continue;
    }
    if (!isConcurrentOperation) {
      continue;
    }

    if (state.statementTimeout !== "unbounded") {
      violations.push(
        `${relativePath}: concurrent index operation has a timeout`,
      );
    }
    state.concurrentBlockOpen = true;
    state.statementTimeoutRestored = false;
    state.lockTimeoutRequiresRestore = state.lockTimeout === "unbounded";
  }

  if (state.concurrentBlockOpen && state.lockTimeoutRequiresRestore) {
    violations.push(`${relativePath}: lock timeout is not restored`);
  }
  if (
    (state.concurrentBlockOpen && !state.statementTimeoutRestored) ||
    (!state.concurrentBlockOpen && state.statementTimeoutRequiresRestore)
  ) {
    violations.push(`${relativePath}: statement timeout is not restored`);
  }

  return violations;
};

const canonicalIdentifier = (identifier: string): string =>
  identifier.startsWith('"')
    ? identifier.slice(1, -1).replaceAll('""', '"')
    : identifier.toLowerCase();

/** A relation without its schema: migrations here address `public` alone. */
const canonicalRelation = (relation: string): string => {
  const parts = relation.match(new RegExp(IDENTIFIER, "gu")) ?? [];
  return canonicalIdentifier(parts.at(-1) ?? relation);
};

const matchedIndexName = (match: RegExpMatchArray): string | undefined => {
  const name = match.groups?.["name"];
  return name === undefined ? undefined : canonicalRelation(name);
};
type ConcurrentIndexMigrationOptions = {
  relativePath: string;
  source: string;
  validatedIndexNames: ReadonlySet<string>;
};

const collectUnsafeConcurrentIndexesInMigration = ({
  relativePath,
  source,
  validatedIndexNames,
}: ConcurrentIndexMigrationOptions): string[] => {
  const violations: string[] = [];
  const sqlWithoutLineComments = stripSqlComments(source);
  for (const match of sqlWithoutLineComments.matchAll(
    CONCURRENT_IF_NOT_EXISTS,
  )) {
    const name = matchedIndexName(match);
    if (!name || !validatedIndexNames.has(name)) {
      violations.push(
        `${relativePath}: ${name ?? "unknown index"} uses IF NOT EXISTS without an online validity postcondition`,
      );
    }
  }

  const droppedIndexes = new Set(
    [...sqlWithoutLineComments.matchAll(CONCURRENT_DROP)].flatMap((match) => {
      const name = matchedIndexName(match);
      return name ? [name] : [];
    }),
  );
  const concurrentUniqueCreates = [
    ...sqlWithoutLineComments.matchAll(CONCURRENT_UNIQUE_CREATE),
  ];
  const concurrentReindexPositions = new Map<string, number[]>();
  for (const match of sqlWithoutLineComments.matchAll(CONCURRENT_REINDEX)) {
    const name = matchedIndexName(match);
    if (name === undefined) {
      continue;
    }
    const positions = concurrentReindexPositions.get(name) ?? [];
    positions.push(match.index);
    concurrentReindexPositions.set(name, positions);
  }
  const firstForeignKeyIndex =
    sqlWithoutLineComments.search(/\bFOREIGN\s+KEY\b/iu);
  const createdUniqueIndexes = new Set(
    concurrentUniqueCreates.flatMap((match) => {
      const name = matchedIndexName(match);
      return name ? [name] : [];
    }),
  );
  if (
    concurrentUniqueCreates.some(({ groups }) => groups?.["idempotent"]) &&
    [...droppedIndexes].some((name) => !createdUniqueIndexes.has(name))
  ) {
    violations.push(
      `${relativePath}: unique replacement drop must follow online validity postconditions`,
    );
  }
  for (const match of concurrentUniqueCreates) {
    const { groups } = match;
    const name = matchedIndexName(match);
    if (!name) {
      continue;
    }
    if (!groups?.["idempotent"]) {
      violations.push(
        `${relativePath}: unique index ${name} is not retry-idempotent`,
      );
    }
    if (
      groups?.["idempotent"] &&
      firstForeignKeyIndex !== -1 &&
      !(concurrentReindexPositions.get(name) ?? []).some(
        (position) => position > match.index && position < firstForeignKeyIndex,
      )
    ) {
      violations.push(
        `${relativePath}: unique index ${name} is used before retry validity repair`,
      );
    }
    if (droppedIndexes.has(name)) {
      violations.push(
        `${relativePath}: retry can remove valid unique index ${name}`,
      );
    }
  }
  violations.push(...collectUnsafeConcurrentTimeouts(relativePath, source));
  return violations.toSorted();
};

const collectUnsafeConcurrentIndexes = async (): Promise<string[]> => {
  const violations: string[] = [];
  const migrationFiles = new Bun.Glob("20*/migration.sql");
  for await (const relativePath of migrationFiles.scan({
    cwd: MIGRATIONS_DIR,
  })) {
    const source = await Bun.file(
      nodePath.join(MIGRATIONS_DIR, relativePath),
    ).text();
    violations.push(
      ...collectUnsafeConcurrentIndexesInMigration({
        relativePath,
        source,
        validatedIndexNames: ONLINE_VALIDATED_INDEX_NAMES,
      }),
    );
  }
  return violations.toSorted();
};

type TypeChangeTimeoutState = {
  activePolicy: TypeChangePolicy | undefined;
  activePolicyUsed: boolean;
  lockTimeout: TimeoutState;
  lockTimeoutCheckpoint: TimeoutState | undefined;
  metadataOnlyBlockOpen: boolean;
  sawCustomStatementBudget: boolean;
  statementTimeout: TimeoutState;
  statementTimeoutCheckpoint: TimeoutState | undefined;
  statementTimeoutRequiresRestore: boolean;
};

const applyTypeChangePolicy = ({
  declaredPolicy,
  relativePath,
  state,
  violations,
}: {
  declaredPolicy: TypeChangePolicy;
  relativePath: string;
  state: TypeChangeTimeoutState;
  violations: string[];
}): void => {
  if (state.metadataOnlyBlockOpen) {
    violations.push(
      `${relativePath}: statement timeout is not restored immediately after metadata-only type changes`,
    );
    state.metadataOnlyBlockOpen = false;
  }
  if (state.activePolicy && !state.activePolicyUsed) {
    violations.push(`${relativePath}: type change policy is unused`);
  }
  state.activePolicy = declaredPolicy;
  state.activePolicyUsed = false;
};

const closeCompletedBoundedRewritePolicy = ({
  isTypeChange,
  state,
}: {
  isTypeChange: boolean;
  state: TypeChangeTimeoutState;
}): void => {
  if (
    state.activePolicy === "boundedRewrite" &&
    state.activePolicyUsed &&
    !isTypeChange
  ) {
    state.activePolicy = undefined;
    state.activePolicyUsed = false;
  }
};

const enforceMetadataOnlyRestore = ({
  isImmediateRestore,
  isTypeChange,
  relativePath,
  state,
  violations,
}: {
  isImmediateRestore: boolean;
  isTypeChange: boolean;
  relativePath: string;
  state: TypeChangeTimeoutState;
  violations: string[];
}): void => {
  if (!state.metadataOnlyBlockOpen) {
    return;
  }
  if (!isTypeChange && !isImmediateRestore) {
    violations.push(
      `${relativePath}: statement timeout is not restored immediately after metadata-only type changes`,
    );
  }
  if (!isTypeChange || isImmediateRestore) {
    state.metadataOnlyBlockOpen = false;
    state.activePolicy = undefined;
    state.activePolicyUsed = false;
  }
};

const applyTypeChangeTimeoutUpdate = ({
  statement,
  state,
  timeoutUpdate,
  relativePath,
  violations,
}: {
  statement: string;
  state: TypeChangeTimeoutState;
  timeoutUpdate: TimeoutUpdate | undefined;
  relativePath: string;
  violations: string[];
}): boolean => {
  if (timeoutUpdate?.type === "checkpoint") {
    if (timeoutUpdate.name === "lock") {
      state.lockTimeoutCheckpoint = state.lockTimeout;
    } else {
      state.statementTimeoutCheckpoint = state.statementTimeout;
    }
    return true;
  }
  if (timeoutUpdate?.type === "restore") {
    const checkpoint =
      timeoutUpdate.name === "lock"
        ? state.lockTimeoutCheckpoint
        : state.statementTimeoutCheckpoint;
    if (checkpoint === undefined) {
      violations.push(
        `${relativePath}: ${timeoutUpdate.name} timeout restore lacks a checkpoint`,
      );
    } else if (timeoutUpdate.name === "lock") {
      state.lockTimeout = checkpoint;
    } else {
      state.statementTimeout = checkpoint;
      state.statementTimeoutRequiresRestore = false;
    }
    return true;
  }
  if (timeoutUpdate?.type === "set") {
    const nextState =
      timeoutUpdate.scope === "session" ? timeoutUpdate.state : "unset";
    if (timeoutUpdate.name === "lock") {
      state.lockTimeout = nextState;
    } else {
      state.statementTimeout = nextState;
      state.statementTimeoutRequiresRestore = nextState === "unbounded";
    }
    return true;
  }
  if (timeoutUpdate?.type === "reset") {
    if (timeoutUpdate.name === "all" || timeoutUpdate.name === "lock") {
      state.lockTimeout = "unset";
    }
    if (timeoutUpdate.name === "all" || timeoutUpdate.name === "statement") {
      state.statementTimeout = "unset";
    }
    return true;
  }
  if (isCustomStatementBudget(statement)) {
    state.sawCustomStatementBudget = true;
    state.statementTimeout = "bounded";
    return true;
  }
  return false;
};

const enforceTypeChangeBudget = ({
  isCustomBoundedMigration,
  relativePath,
  state,
  typeChangeClauseCount,
  violations,
}: {
  isCustomBoundedMigration: boolean;
  relativePath: string;
  state: TypeChangeTimeoutState;
  typeChangeClauseCount: number;
  violations: string[];
}): void => {
  if (!isCustomBoundedMigration && !state.activePolicy) {
    violations.push(
      `${relativePath}: type change lacks an explicit execution policy`,
    );
    return;
  }
  if (state.lockTimeout !== "bounded") {
    violations.push(`${relativePath}: type change has an unbounded lock wait`);
  }
  if (isCustomBoundedMigration) {
    if (
      !state.sawCustomStatementBudget ||
      state.statementTimeout !== "bounded"
    ) {
      violations.push(
        `${relativePath}: custom type rewrite lacks its bounded execution budget`,
      );
    }
    return;
  }
  if (state.activePolicy === "metadataOnly" && typeChangeClauseCount > 1) {
    violations.push(
      `${relativePath}: multiple type changes in one statement are not supported by the metadata-only timeout policy`,
    );
    return;
  }
  state.activePolicyUsed = true;
  if (state.activePolicy === "metadataOnly") {
    if (state.statementTimeout !== "unbounded") {
      violations.push(
        `${relativePath}: type change has a bounded execution timeout`,
      );
    }
    state.metadataOnlyBlockOpen = true;
    return;
  }
  if (state.statementTimeout !== "bounded") {
    violations.push(
      `${relativePath}: type rewrite lacks a bounded execution timeout`,
    );
  }
};

const collectUnsafeTypeChangesInMigration = (
  relativePath: string,
  source: string,
) => {
  const violations = [];
  const isCustomBoundedMigration =
    CUSTOM_BOUNDED_TYPE_CHANGE_MIGRATIONS.has(relativePath);
  const statements = splitSqlStatements(source);

  const state: TypeChangeTimeoutState = {
    activePolicy: undefined,
    activePolicyUsed: false,
    lockTimeout: "unset",
    lockTimeoutCheckpoint: undefined,
    metadataOnlyBlockOpen: false,
    sawCustomStatementBudget: false,
    statementTimeout: "unset",
    statementTimeoutCheckpoint: undefined,
    statementTimeoutRequiresRestore: false,
  };

  for (const statement of statements) {
    const typeChangeClauseCount = [...statement.matchAll(TYPE_CHANGE_CLAUSE)]
      .length;
    if (TRANSACTION_REVERSAL.test(statement)) {
      violations.push(
        `${relativePath}: timeout safety does not support transaction reversal`,
      );
      continue;
    }
    if (isUnapprovedProceduralStatement(relativePath, statement)) {
      violations.push(
        `${relativePath}: procedural migration statement is not approved`,
      );
      continue;
    }
    if (/^DO\b/iu.test(statement) && TYPE_CHANGE_ANYWHERE.test(statement)) {
      violations.push(
        `${relativePath}: procedural type changes are not supported by the timeout safety policy`,
      );
      continue;
    }

    const declaredPolicy = parseTypeChangePolicy(statement);
    if (declaredPolicy) {
      applyTypeChangePolicy({
        declaredPolicy,
        relativePath,
        state,
        violations,
      });
      continue;
    }

    const timeoutUpdate = parseTimeoutUpdate(statement);
    const isTypeChange = TYPE_CHANGE.test(statement);
    const isImmediateRestore =
      (timeoutUpdate?.type === "restore" &&
        timeoutUpdate.name === "statement" &&
        state.statementTimeoutCheckpoint !== undefined) ||
      (timeoutUpdate?.type === "set" &&
        timeoutUpdate.name === "statement" &&
        timeoutUpdate.scope === "session" &&
        timeoutUpdate.state === "bounded");

    closeCompletedBoundedRewritePolicy({ isTypeChange, state });
    enforceMetadataOnlyRestore({
      isImmediateRestore,
      isTypeChange,
      relativePath,
      state,
      violations,
    });
    if (
      applyTypeChangeTimeoutUpdate({
        relativePath,
        state,
        statement,
        timeoutUpdate,
        violations,
      })
    ) {
      continue;
    }
    if (!isTypeChange) {
      continue;
    }

    enforceTypeChangeBudget({
      isCustomBoundedMigration,
      relativePath,
      state,
      typeChangeClauseCount,
      violations,
    });
  }

  if (state.activePolicy && !state.activePolicyUsed) {
    violations.push(`${relativePath}: type change policy is unused`);
  }
  if (state.metadataOnlyBlockOpen || state.statementTimeoutRequiresRestore) {
    violations.push(`${relativePath}: statement timeout is not restored`);
  }

  return violations;
};

const collectUnsafeTypeChanges = async () => {
  const violations = [];
  const migrationFiles = new Bun.Glob("20*/migration.sql");

  for await (const relativePath of migrationFiles.scan({
    cwd: MIGRATIONS_DIR,
  })) {
    const source = await Bun.file(
      nodePath.join(MIGRATIONS_DIR, relativePath),
    ).text();
    violations.push(
      ...collectUnsafeTypeChangesInMigration(relativePath, source),
    );
  }

  return violations.toSorted();
};

describe("concurrent index migration safety", () => {
  test.each([
    { spelling: "index_name", name: "index_name" },
    { spelling: "INDEX_NAME", name: "index_name" },
    { spelling: '"MixedName"', name: "MixedName" },
    { spelling: 'public."MixedName"', name: "MixedName" },
    { spelling: '"escaped""name"', name: 'escaped"name' },
  ])(
    "recognizes concurrent index identifier $spelling",
    ({ spelling, name }) => {
      const operations = [
        {
          sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${spelling} ON contacts (id);`,
          pattern: CONCURRENT_IF_NOT_EXISTS,
        },
        {
          sql: `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ${spelling} ON contacts (id);`,
          pattern: CONCURRENT_UNIQUE_CREATE,
        },
        {
          sql: `DROP INDEX CONCURRENTLY IF EXISTS ${spelling};`,
          pattern: CONCURRENT_DROP,
        },
        {
          sql: `REINDEX INDEX CONCURRENTLY ${spelling};`,
          pattern: CONCURRENT_REINDEX,
        },
      ];
      for (const { sql, pattern } of operations) {
        expect([...sql.matchAll(pattern)].map(matchedIndexName)).toEqual([
          name,
        ]);
      }
    },
  );

  test("removing either sanctions cursor index registration fails the migration guard", async () => {
    const relativePath =
      "20261003123000_sanctions_monitoring_review_index/migration.sql";
    const source = await Bun.file(
      nodePath.join(MIGRATIONS_DIR, relativePath),
    ).text();
    const names = [
      ...stripSqlComments(source).matchAll(CONCURRENT_IF_NOT_EXISTS),
    ].map(matchedIndexName);
    expect(names).toHaveLength(2);
    expect(
      collectUnsafeConcurrentIndexesInMigration({
        relativePath,
        source,
        validatedIndexNames: ONLINE_VALIDATED_INDEX_NAMES,
      }),
    ).toEqual([]);
    for (const name of names) {
      if (name === undefined) {
        panic("Concurrent index identifier was not captured");
      }
      const validatedIndexNames = new Set(ONLINE_VALIDATED_INDEX_NAMES);
      expect(validatedIndexNames.delete(name)).toBe(true);
      expect(
        collectUnsafeConcurrentIndexesInMigration({
          relativePath,
          source,
          validatedIndexNames,
        }),
      ).toEqual([
        `${relativePath}: ${name} uses IF NOT EXISTS without an online validity postcondition`,
      ]);
    }
  });

  test("enforces bounded-lock, unbounded-build, and validity-aware retries", async () => {
    expect(await collectUnsafeConcurrentIndexes()).toEqual([]);
  });
});

describe("lock-sensitive migration DDL", () => {
  const customStatementBudget = `DO $$
DECLARE current_ms integer;
BEGIN
  SELECT setting::integer INTO current_ms
  FROM pg_settings WHERE name = 'statement_timeout';
  IF current_ms = 0 OR current_ms < 1200000 THEN
    PERFORM set_config('statement_timeout', '20min', false);
  END IF;
END
$$;`;

  test("classifies zero-duration timeout unit forms as unbounded", () => {
    for (const value of ["0", "'0'", "0us", "'0ms'", "0s", "'0min'"]) {
      expect(classifyTimeout(value)).toBe("unbounded");
    }
    for (const value of ["1ms", "'5s'", "20min"]) {
      expect(classifyTimeout(value)).toBe("bounded");
    }
  });

  test("recognizes both PostgreSQL type-change spellings", () => {
    expect(
      TYPE_CHANGE.test(
        'ALTER TABLE "example" ALTER COLUMN "value" TYPE timestamptz',
      ),
    ).toBe(true);
    expect(
      TYPE_CHANGE.test(
        'ALTER TABLE "example" ALTER COLUMN "value" SET DATA TYPE varchar(64)',
      ),
    ).toBe(true);
    expect(
      TYPE_CHANGE.test('ALTER TABLE "example" ALTER "value" TYPE timestamptz'),
    ).toBe(true);
    expect(
      TYPE_CHANGE.test(
        "ALTER TABLE example ALTER COLUMN café TYPE timestamptz",
      ),
    ).toBe(true);
    expect(
      TYPE_CHANGE.test(
        'ALTER TABLE example ALTER COLUMN "a""b" TYPE timestamptz',
      ),
    ).toBe(true);
    expect(
      TYPE_CHANGE.test(
        String.raw`ALTER TABLE example ALTER COLUMN U&"d\0061t" TYPE timestamptz`,
      ),
    ).toBe(true);
  });

  test("requires immediate timeout restoration after metadata-only blocks", () => {
    const safePrefix = `
-- ${TYPE_CHANGE_POLICY.metadataOnly}
SET lock_timeout = '1s';
SET statement_timeout = 0;
ALTER TABLE "example" ALTER COLUMN "value" TYPE varchar(64);`;

    expect(
      collectUnsafeTypeChangesInMigration(
        "safe/migration.sql",
        `${safePrefix}\nSET statement_timeout = '5s';\nSELECT 1;`,
      ),
    ).toEqual([]);
    expect(
      collectUnsafeTypeChangesInMigration(
        "unsafe/migration.sql",
        `${safePrefix}\nSELECT 1;\nSET statement_timeout = '5s';`,
      ),
    ).toContain(
      "unsafe/migration.sql: statement timeout is not restored immediately after metadata-only type changes",
    );
  });

  test("scopes execution policies to contiguous type-change blocks", () => {
    const safeSource = `
SET lock_timeout = '1s';
-- ${TYPE_CHANGE_POLICY.metadataOnly}
SET statement_timeout = 0;
ALTER TABLE example ALTER COLUMN value TYPE varchar(64);
SET statement_timeout = '5s';
-- ${TYPE_CHANGE_POLICY.boundedRewrite}
ALTER TABLE example ALTER COLUMN created_at TYPE timestamptz;
SELECT 1;`;
    expect(
      collectUnsafeTypeChangesInMigration("safe/migration.sql", safeSource),
    ).toEqual([]);
    expect(
      collectUnsafeTypeChangesInMigration(
        "unsafe/migration.sql",
        safeSource.replace(`-- ${TYPE_CHANGE_POLICY.boundedRewrite}\n`, ""),
      ),
    ).toContain(
      "unsafe/migration.sql: type change lacks an explicit execution policy",
    );
  });

  test("rejects transaction-local timeout protocols", () => {
    const relativePath = "20260729150000_timestamptz_everywhere/migration.sql";
    expect(parseTimeoutUpdate("SET LOCAL statement_timeout = 0")).toEqual({
      type: "set",
      name: "statement",
      scope: "local",
      state: "unbounded",
    });
    expect(
      collectUnsafeTypeChangesInMigration(
        relativePath,
        `BEGIN;
        SET LOCAL lock_timeout = '1s';
        COMMIT;
        ${customStatementBudget}
        ALTER TABLE example ALTER COLUMN value TYPE timestamptz;`,
      ),
    ).toContain(`${relativePath}: type change has an unbounded lock wait`);
    expect(parseTimeoutUpdate("SET statement_timeout FROM CURRENT")).toEqual({
      type: "preserve",
      name: "statement",
      scope: "session",
    });
  });

  test("tracks every timeout form around concurrent index operations", () => {
    const unsafePrefix = "SET statement_timeout = 0; RESET statement_timeout;";
    expect(
      collectUnsafeConcurrentTimeouts(
        "reset/migration.sql",
        `${unsafePrefix} CREATE INDEX CONCURRENTLY example_idx ON example (id);`,
      ),
    ).toContain(
      "reset/migration.sql: concurrent index operation has a timeout",
    );
    expect(
      collectUnsafeConcurrentTimeouts(
        "to/migration.sql",
        `SET statement_timeout = 0;
        SET statement_timeout TO '5s';
        CREATE INDEX CONCURRENTLY example_idx ON example (id);`,
      ),
    ).toContain("to/migration.sql: concurrent index operation has a timeout");
    expect(
      collectUnsafeConcurrentTimeouts(
        "set-config/migration.sql",
        `SET statement_timeout = 0;
        SELECT set_config('statement_timeout', '5s', false);
        CREATE INDEX CONCURRENTLY example_idx ON example (id);`,
      ),
    ).toContain(
      "set-config/migration.sql: concurrent index operation has a timeout",
    );
    expect(
      collectUnsafeConcurrentTimeouts(
        "safe/migration.sql",
        `SET SESSION statement_timeout TO 0;
        CREATE INDEX CONCURRENTLY example_idx ON example (id);
        SET statement_timeout = '5s';`,
      ),
    ).toEqual([]);
    expect(
      collectUnsafeConcurrentTimeouts(
        "safe-set-config/migration.sql",
        `SELECT pg_catalog.set_config('statement_timeout', '0', false);
        CREATE INDEX CONCURRENTLY example_idx ON example (id);
        SELECT set_config('statement_timeout', '5s', false);`,
      ),
    ).toEqual([]);
    expect(
      collectUnsafeConcurrentTimeouts(
        "from-current/migration.sql",
        `SET statement_timeout = 0;
        CREATE INDEX CONCURRENTLY example_idx ON example (id);
        SET statement_timeout FROM CURRENT;`,
      ),
    ).toContain(
      "from-current/migration.sql: timeouts are not restored immediately after concurrent index operations",
    );
    expect(
      collectUnsafeConcurrentTimeouts(
        "reset-restore/migration.sql",
        `SET statement_timeout = 0;
        CREATE INDEX CONCURRENTLY example_idx ON example (id);
        RESET statement_timeout;`,
      ),
    ).toContain(
      "reset-restore/migration.sql: timeouts are not restored immediately after concurrent index operations",
    );
    expect(
      collectUnsafeConcurrentTimeouts(
        "discard-all/migration.sql",
        `SET statement_timeout = 0;
        DISCARD ALL;
        CREATE INDEX CONCURRENTLY example_idx ON example (id);`,
      ),
    ).toContain(
      "discard-all/migration.sql: concurrent index operation has a timeout",
    );
    expect(
      collectUnsafeConcurrentTimeouts(
        "unbounded-lock/migration.sql",
        `SET statement_timeout = 0;
        SET lock_timeout = 0;
        CREATE INDEX CONCURRENTLY example_idx ON example (id);
        SET statement_timeout = '5s';`,
      ),
    ).toContain("unbounded-lock/migration.sql: lock timeout is not restored");
    for (const reset of ["RESET lock_timeout", "DISCARD ALL"]) {
      expect(
        collectUnsafeConcurrentTimeouts(
          "reset-lock/migration.sql",
          `SET statement_timeout = 0;
          SET lock_timeout = '1s';
          CREATE INDEX CONCURRENTLY example_idx ON example (id);
          ${reset};
          SET statement_timeout = '5s';`,
        ),
      ).toContain("reset-lock/migration.sql: lock timeout is not restored");
    }
    expect(
      collectUnsafeConcurrentTimeouts(
        "restored-lock/migration.sql",
        `SET statement_timeout = 0;
        SET lock_timeout = 0;
        CREATE INDEX CONCURRENTLY example_idx ON example (id);
        SET statement_timeout = '5s';
        SET lock_timeout = '1s';`,
      ),
    ).toEqual([]);
  });

  test("restores the exact incoming timeout state after concurrent work", () => {
    const checkpoint = `SELECT set_config(
      'stella.migration_statement_timeout',
      current_setting('statement_timeout'),
      false
    )`;
    const restore = `SELECT set_config(
      'statement_timeout',
      current_setting('stella.migration_statement_timeout'),
      false
    )`;

    expect(parseTimeoutUpdate(checkpoint)).toEqual({
      name: "statement",
      type: "checkpoint",
    });
    expect(parseTimeoutUpdate(restore)).toEqual({
      name: "statement",
      type: "restore",
    });
    expect(
      collectUnsafeConcurrentTimeouts(
        "preserved/migration.sql",
        `${checkpoint};
        SET statement_timeout = 0;
        CREATE INDEX CONCURRENTLY example_idx ON example (id);
        ${restore};`,
      ),
    ).toEqual([]);
    expect(
      collectUnsafeConcurrentTimeouts(
        "missing-checkpoint/migration.sql",
        `SET statement_timeout = 0;
        CREATE INDEX CONCURRENTLY example_idx ON example (id);
        ${restore};`,
      ),
    ).toContain(
      "missing-checkpoint/migration.sql: statement timeout restore lacks a checkpoint",
    );
  });

  test("rejects transaction reversal in timeout protocols", () => {
    expect(
      collectUnsafeConcurrentTimeouts(
        "rollback/migration.sql",
        `BEGIN;
        SET statement_timeout = 0;
        ROLLBACK;
        CREATE INDEX CONCURRENTLY example_idx ON example (id);`,
      ),
    ).toContain(
      "rollback/migration.sql: timeout safety does not support transaction reversal",
    );
    expect(
      collectUnsafeConcurrentTimeouts(
        "savepoint/migration.sql",
        `SAVEPOINT before_timeout;
        SET statement_timeout = 0;
        CREATE INDEX CONCURRENTLY example_idx ON example (id);`,
      ),
    ).toContain(
      "savepoint/migration.sql: timeout safety does not support transaction reversal",
    );
    expect(
      collectUnsafeTypeChangesInMigration(
        "type-rollback/migration.sql",
        `BEGIN;
        SET lock_timeout = '1s';
        ROLLBACK;
        -- ${TYPE_CHANGE_POLICY.boundedRewrite}
        SET statement_timeout = '5s';
        ALTER TABLE example ALTER COLUMN value TYPE timestamptz;`,
      ),
    ).toContain(
      "type-rollback/migration.sql: timeout safety does not support transaction reversal",
    );
    expect(
      collectUnsafeTypeChangesInMigration(
        "type-abort/migration.sql",
        `BEGIN;
        SET lock_timeout = '1s';
        ABORT;
        -- ${TYPE_CHANGE_POLICY.boundedRewrite}
        SET statement_timeout = '5s';
        ALTER TABLE example ALTER COLUMN value TYPE timestamptz;`,
      ),
    ).toContain(
      "type-abort/migration.sql: timeout safety does not support transaction reversal",
    );
  });

  test("rejects timeout mutations hidden in procedural blocks", () => {
    for (const command of [
      "PERFORM set_config('lock_timeout', '0', false);",
      `PERFORM pg_catalog."set_config"('lock_timeout', '0', false);`,
      "RESET ALL;",
      "DISCARD ALL;",
      "EXECUTE 'RESET ALL';",
      "EXECUTE 'RESET ' || 'ALL';",
      "EXECUTE format('RESET %s', 'ALL');",
    ]) {
      const mutation = `DO $$ BEGIN ${command} END $$;`;
      expect(
        collectUnsafeConcurrentTimeouts(
          "concurrent/migration.sql",
          `SET statement_timeout = 0;
          ${mutation}
          CREATE INDEX CONCURRENTLY example_idx ON example (id);
          SET statement_timeout = '5s';`,
        ),
      ).toContain(
        "concurrent/migration.sql: procedural migration statement is not approved",
      );
      expect(
        collectUnsafeTypeChangesInMigration(
          "type-change/migration.sql",
          `SET lock_timeout = '1s';
          SET statement_timeout = '5s';
          ${mutation}
          -- ${TYPE_CHANGE_POLICY.boundedRewrite}
          ALTER TABLE example ALTER COLUMN value TYPE timestamptz;`,
        ),
      ).toContain(
        "type-change/migration.sql: procedural migration statement is not approved",
      );
    }
  });

  test("keeps lock waits bounded for custom execution budgets", () => {
    const relativePath = "20260729150000_timestamptz_everywhere/migration.sql";
    for (const timeoutSetup of [
      "SET lock_timeout = 0",
      "SET lock_timeout = '1s'; RESET lock_timeout",
      "SET lock_timeout = '1s'; SET lock_timeout TO 0ms",
      "SET lock_timeout = '1s'; RESET ALL",
    ]) {
      expect(
        collectUnsafeTypeChangesInMigration(
          relativePath,
          `${timeoutSetup}; ALTER TABLE example ALTER COLUMN value TYPE timestamptz;`,
        ),
      ).toContain(`${relativePath}: type change has an unbounded lock wait`);
    }
    expect(
      collectUnsafeTypeChangesInMigration(
        relativePath,
        `SET SESSION lock_timeout TO '1s';
        ${customStatementBudget}
        ALTER TABLE example ALTER COLUMN value TYPE timestamptz;`,
      ),
    ).toEqual([]);
    expect(
      collectUnsafeTypeChangesInMigration(
        relativePath,
        `SELECT set_config('lock_timeout', '1s', false);
        ${customStatementBudget}
        SELECT set_config('lock_timeout', '0', false);
        ALTER TABLE example ALTER COLUMN value TYPE timestamptz;`,
      ),
    ).toContain(`${relativePath}: type change has an unbounded lock wait`);
  });

  test("requires and preserves the custom statement budget", () => {
    const relativePath = "20260729150000_timestamptz_everywhere/migration.sql";
    const typeChange =
      "ALTER TABLE example ALTER COLUMN value TYPE timestamptz;";
    expect(
      collectUnsafeTypeChangesInMigration(
        relativePath,
        `SET lock_timeout = '1s'; ${typeChange}`,
      ),
    ).toContain(
      `${relativePath}: custom type rewrite lacks its bounded execution budget`,
    );
    expect(
      collectUnsafeTypeChangesInMigration(
        relativePath,
        `SET lock_timeout = '1s';
        ${customStatementBudget}
        RESET statement_timeout;
        ${typeChange}`,
      ),
    ).toContain(
      `${relativePath}: custom type rewrite lacks its bounded execution budget`,
    );
    const budgetWithExtraMutation = customStatementBudget.replace(
      "END IF;",
      "END IF; PERFORM set_config('statement_timeout', '0', false);",
    );
    expect(
      collectUnsafeTypeChangesInMigration(
        relativePath,
        `SET lock_timeout = '1s';
        ${budgetWithExtraMutation}
        ${typeChange}`,
      ),
    ).toContain(
      `${relativePath}: procedural migration statement is not approved`,
    );
  });

  test("requires exact approval for procedural statements", () => {
    const relativePath = "20260729150000_timestamptz_everywhere/migration.sql";
    expect(
      collectUnsafeTypeChangesInMigration(
        relativePath,
        `SELECT 1; -- SET lock_timeout = '1s';
        /* SET lock_timeout = '1s'; */
        ALTER TABLE example ALTER COLUMN value TYPE timestamptz;`,
      ),
    ).toContain(`${relativePath}: type change has an unbounded lock wait`);
    expect(
      collectUnsafeTypeChangesInMigration(
        relativePath,
        `SET lock_timeout = '1s';
        ${customStatementBudget}
        SELECT '-- RESET lock_timeout';
        DO $body$ BEGIN PERFORM '/* RESET ALL */'; END $body$;
        /* RESET lock_timeout; */
        ALTER TABLE example ALTER COLUMN value TYPE timestamptz;`,
      ),
    ).toContain(
      `${relativePath}: procedural migration statement is not approved`,
    );
  });

  test("applies backslash escaping only to PostgreSQL escape strings", () => {
    const ordinaryStringSource = String.raw`SELECT '\';
      ALTER TABLE example ALTER COLUMN value TYPE varchar(64);`;
    expect(splitSqlStatements(ordinaryStringSource)).toHaveLength(2);
    expect(
      collectUnsafeTypeChangesInMigration(
        "ordinary-string/migration.sql",
        ordinaryStringSource,
      ),
    ).toContain(
      "ordinary-string/migration.sql: type change lacks an explicit execution policy",
    );

    expect(
      splitSqlStatements(String.raw`SELECT E'it\'s; still quoted'; SELECT 1;`),
    ).toHaveLength(2);
  });

  test("requires token boundaries for dollar-quoted bodies", () => {
    for (const identifier of ["foo$bar$", "café$tag$"]) {
      const identifierSource = `SELECT ${identifier};
        ALTER TABLE example ALTER COLUMN value TYPE varchar(64);`;
      expect(splitSqlStatements(identifierSource)).toHaveLength(2);
      expect(
        collectUnsafeTypeChangesInMigration(
          "dollar-identifier/migration.sql",
          identifierSource,
        ),
      ).toContain(
        "dollar-identifier/migration.sql: type change lacks an explicit execution policy",
      );
    }

    expect(
      splitSqlStatements("DO $täg$ SELECT ';'; $täg$; SELECT 1;"),
    ).toHaveLength(2);
  });

  test("rejects type changes hidden inside procedural bodies", () => {
    expect(
      collectUnsafeTypeChangesInMigration(
        "procedural/migration.sql",
        `DO $$
        BEGIN
          ALTER TABLE example ALTER COLUMN value TYPE varchar(64);
        END
        $$;`,
      ),
    ).toContain(
      "procedural/migration.sql: procedural migration statement is not approved",
    );
  });

  test("requires one execution policy per type-change statement", () => {
    expect(
      collectUnsafeTypeChangesInMigration(
        "combined/migration.sql",
        `SET lock_timeout = '1s';
        -- ${TYPE_CHANGE_POLICY.metadataOnly}
        SET statement_timeout = 0;
        ALTER TABLE example
          ALTER COLUMN metadata_value TYPE varchar(64),
          ALTER COLUMN rewritten_value TYPE timestamptz;`,
      ),
    ).toContain(
      "combined/migration.sql: multiple type changes in one statement are not supported by the metadata-only timeout policy",
    );
  });

  test("bounds lock waits without interrupting acquired type changes", async () => {
    expect(await collectUnsafeTypeChanges()).toEqual([]);
  });
});

/**
 * A migration that splits the migrator's transaction commits everything
 * before its `COMMIT` ahead of the migration row. A failure after that point
 * replays the file from the top, so every statement before the split has to
 * be one a second run survives.
 */
const REPLAY_SAFE_BEFORE_SPLIT: readonly RegExp[] = [
  /^SET\b/iu,
  /^RESET\s+ROLE$/iu,
  /^SELECT\s+set_config\s*\(/iu,
  // Procedural blocks are approved one by one above, by fingerprint.
  /^DO\b/iu,
  /^(?:GRANT|REVOKE)\b/iu,
  /^COMMENT\s+ON\b/iu,
  /^CREATE\s+OR\s+REPLACE\b/iu,
  /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?IF\s+NOT\s+EXISTS\b/iu,
  /^CREATE\s+(?:TABLE|SEQUENCE|EXTENSION|SCHEMA)\s+IF\s+NOT\s+EXISTS\b/iu,
  /^DROP\s+[A-Z ]+?\s+IF\s+EXISTS\b/iu,
];

/** One action of an `ALTER TABLE` that a second run survives on its own. */
const REPLAY_SAFE_TABLE_ACTIONS: readonly RegExp[] = [
  /^ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\b/iu,
  /^DROP\s+(?:COLUMN|CONSTRAINT)\s+IF\s+EXISTS\b/iu,
  /^ALTER\s+(?:COLUMN\s+)?\S+\s+(?:(?:SET|DROP)\s+(?:DEFAULT|NOT\s+NULL)|SET\s+DATA\s+TYPE|TYPE)\b/iu,
  /^VALIDATE\s+CONSTRAINT\b/iu,
  /^(?:ENABLE|FORCE)\s+ROW\s+LEVEL\s+SECURITY$/iu,
];

const ALTER_TABLE = new RegExp(
  String.raw`^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?<table>${RELATION})\s+(?<actions>[\s\S]+)$`,
  "iu",
);
const ADD_CONSTRAINT_ACTION = new RegExp(
  String.raw`^ADD\s+CONSTRAINT\s+(?<name>${IDENTIFIER})`,
  "iu",
);
const DROP_CONSTRAINT_ACTION = new RegExp(
  String.raw`^DROP\s+CONSTRAINT\s+IF\s+EXISTS\s+(?<name>${IDENTIFIER})`,
  "iu",
);
const CREATE_NAMED_ON_TABLE = new RegExp(
  String.raw`^CREATE\s+(?:CONSTRAINT\s+)?(?<kind>POLICY|TRIGGER)\s+(?<name>${IDENTIFIER})[\s\S]*?\bON\s+(?<table>${RELATION})`,
  "iu",
);
const DROP_NAMED_ON_TABLE = new RegExp(
  String.raw`^DROP\s+(?<kind>POLICY|TRIGGER)\s+IF\s+EXISTS\s+(?<name>${IDENTIFIER})\s+ON\s+(?<table>${RELATION})`,
  "iu",
);

/** An identifier as PostgreSQL resolves it: unquoted folds to lower case. */

/** Split on the commas that separate actions, not the ones inside parentheses. */
const splitTableActions = (actions: string): string[] => {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = "";
  for (const character of actions) {
    if (character === '"') {
      quoted = !quoted;
    }
    if (!quoted && character === "(") {
      depth += 1;
    }
    if (!quoted && character === ")") {
      depth -= 1;
    }
    if (!quoted && depth === 0 && character === ",") {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  parts.push(current.trim());
  return parts;
};

type DroppedObject = { kind: string; table: string; name: string };

/** Every object an earlier statement dropped behind an `IF EXISTS`. */
const droppedObjects = (earlier: readonly string[]): DroppedObject[] => {
  const dropped: DroppedObject[] = [];
  for (const statement of earlier) {
    const alter = ALTER_TABLE.exec(statement)?.groups;
    if (alter !== undefined) {
      for (const action of splitTableActions(alter["actions"] ?? "")) {
        const name = DROP_CONSTRAINT_ACTION.exec(action)?.groups?.["name"];
        if (name !== undefined) {
          dropped.push({
            kind: "CONSTRAINT",
            table: canonicalRelation(alter["table"] ?? ""),
            name: canonicalIdentifier(name),
          });
        }
      }
    }
    const named = DROP_NAMED_ON_TABLE.exec(statement)?.groups;
    if (named !== undefined) {
      dropped.push({
        kind: (named["kind"] ?? "").toUpperCase(),
        table: canonicalRelation(named["table"] ?? ""),
        name: canonicalIdentifier(named["name"] ?? ""),
      });
    }
  }
  return dropped;
};

const wasDropped = (
  dropped: readonly DroppedObject[],
  wanted: DroppedObject,
): boolean =>
  dropped.some(
    (candidate) =>
      candidate.kind === wanted.kind &&
      candidate.table === wanted.table &&
      candidate.name === wanted.name,
  );

const isReplaySafeBeforeSplit = (
  statement: string,
  earlier: readonly string[],
): boolean => {
  if (REPLAY_SAFE_BEFORE_SPLIT.some((pattern) => pattern.test(statement))) {
    return true;
  }
  const dropped = droppedObjects(earlier);
  const alter = ALTER_TABLE.exec(statement)?.groups;
  if (alter !== undefined) {
    const table = canonicalRelation(alter["table"] ?? "");
    // Every action has to survive on its own: one guarded clause says nothing
    // about the unguarded one beside it.
    return splitTableActions(alter["actions"] ?? "").every((action) => {
      if (REPLAY_SAFE_TABLE_ACTIONS.some((pattern) => pattern.test(action))) {
        return true;
      }
      const name = ADD_CONSTRAINT_ACTION.exec(action)?.groups?.["name"];
      return (
        name !== undefined &&
        wasDropped(dropped, {
          kind: "CONSTRAINT",
          table,
          name: canonicalIdentifier(name),
        })
      );
    });
  }
  const named = CREATE_NAMED_ON_TABLE.exec(statement)?.groups;
  if (named !== undefined) {
    return wasDropped(dropped, {
      kind: (named["kind"] ?? "").toUpperCase(),
      table: canonicalRelation(named["table"] ?? ""),
      name: canonicalIdentifier(named["name"] ?? ""),
    });
  }
  return false;
};

const isRowScanningStatement = (relativePath: string, statement: string) => {
  if (
    /^CREATE(?:\s+OR\s+REPLACE)?\s+FUNCTION\b/iu.test(statement) ||
    /^CREATE\s+POLICY\b/iu.test(statement) ||
    (/^DO\b/iu.test(statement) &&
      !isUnapprovedProceduralStatement(relativePath, statement))
  ) {
    return false;
  }
  return (
    /^UPDATE\b/iu.test(statement) ||
    /\bVALIDATE\s+CONSTRAINT\b/iu.test(statement) ||
    (/\bCHECK\s*\(/iu.test(statement) && !/\bNOT\s+VALID\b/iu.test(statement))
  );
};

/**
 * Earlier migrations are applied history and cannot be rewritten, so the rule
 * binds from the day it was written. A migration directory sorts by its
 * timestamp, which makes the boundary a plain string comparison.
 */
const REPLAY_SAFE_SPLIT_FROM = "20260919";
const ROW_SCAN_SPLIT_FROM = "20261003123100";

const collectUnreplayableSplitPrefixes = async (): Promise<string[]> => {
  const violations: string[] = [];
  for await (const relativePath of new Bun.Glob("20*/migration.sql").scan({
    cwd: MIGRATIONS_DIR,
  })) {
    if (relativePath < REPLAY_SAFE_SPLIT_FROM) {
      continue;
    }
    const statements = splitSqlStatements(
      await Bun.file(nodePath.join(MIGRATIONS_DIR, relativePath)).text(),
    );
    const split = statements.findIndex((statement) =>
      /^COMMIT$/iu.test(statement),
    );
    if (split === -1) {
      continue;
    }
    const prefix = statements.slice(0, split);
    for (const [index, statement] of prefix.entries()) {
      if (!isReplaySafeBeforeSplit(statement, prefix.slice(0, index))) {
        violations.push(
          `${relativePath}: ${statement.replaceAll(/\s+/gu, " ").slice(0, 90)}`,
        );
      }
    }
  }
  return violations.toSorted();
};

describe("split-transaction migrations", () => {
  test("releases schema locks before scanning rows in new split migrations", async () => {
    const violations: string[] = [];
    for await (const relativePath of new Bun.Glob("20*/migration.sql").scan({
      cwd: MIGRATIONS_DIR,
    })) {
      if (relativePath < ROW_SCAN_SPLIT_FROM) {
        continue;
      }
      const statements = splitSqlStatements(
        await Bun.file(nodePath.join(MIGRATIONS_DIR, relativePath)).text(),
      );
      const split = statements.findIndex((statement) =>
        /^COMMIT$/iu.test(statement),
      );
      if (split === -1) {
        continue;
      }
      for (const statement of statements.slice(0, split)) {
        if (isRowScanningStatement(relativePath, statement)) {
          violations.push(`${relativePath}: row scan before transaction split`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test("every statement before the split survives a replay", async () => {
    expect(await collectUnreplayableSplitPrefixes()).toEqual([]);
  });

  test("tells a replayable statement from one a second run would fail on", () => {
    const cases: readonly (readonly [string, readonly string[], boolean])[] = [
      ["RESET ROLE", [], true],
      ["RESET ALL", [], false],
      [`ALTER TABLE "t" ADD COLUMN "c" integer`, [], false],
      [`ALTER TABLE "t" ADD COLUMN IF NOT EXISTS "c" integer`, [], true],
      [
        `ALTER TABLE "t" ADD COLUMN IF NOT EXISTS "a" integer, ADD COLUMN "b" integer`,
        [],
        false,
      ],
      [`ALTER TABLE "t" ADD CONSTRAINT "k" CHECK (true) NOT VALID`, [], false],
      [
        `ALTER TABLE "t" ADD CONSTRAINT "k" CHECK (true) NOT VALID`,
        [`ALTER TABLE "t" DROP CONSTRAINT IF EXISTS "k"`],
        true,
      ],
      [
        `ALTER TABLE "t" ADD CONSTRAINT "k" CHECK (true) NOT VALID`,
        [`ALTER TABLE "t" DROP CONSTRAINT IF EXISTS "other"`],
        false,
      ],
      [`CREATE POLICY "p" ON "t" FOR SELECT TO r USING (true)`, [], false],
      [
        `CREATE POLICY "p" ON "t" FOR SELECT TO r USING (true)`,
        [`DROP POLICY IF EXISTS "p" ON "t"`],
        true,
      ],
      [`CREATE TABLE "t" ("id" uuid)`, [], false],
      [`CREATE TABLE IF NOT EXISTS "t" ("id" uuid)`, [], true],
      [`GRANT SELECT ("c") ON TABLE "t" TO r`, [], true],
      [`UPDATE "t" SET "c" = 1`, [], false],
      // One guarded action does not excuse the unguarded one beside it.
      [
        `ALTER TABLE "t" DROP COLUMN "old", ADD COLUMN IF NOT EXISTS "new" integer`,
        [],
        false,
      ],
      [
        `ALTER TABLE "t" DROP COLUMN IF EXISTS "old", ADD COLUMN IF NOT EXISTS "new" integer`,
        [],
        true,
      ],
      // A comma inside a CHECK is not an action boundary.
      [
        `ALTER TABLE "t" ADD CONSTRAINT "k" CHECK ("c" IN ('a', 'b')) NOT VALID`,
        [`ALTER TABLE "t" DROP CONSTRAINT IF EXISTS "k"`],
        true,
      ],
      // The drop has to name this object on this relation, exactly.
      [
        `ALTER TABLE "t" ADD CONSTRAINT "k" CHECK (true) NOT VALID`,
        [`ALTER TABLE "other" DROP CONSTRAINT IF EXISTS "k"`],
        false,
      ],
      [
        `ALTER TABLE "t" ADD CONSTRAINT "k" CHECK (true) NOT VALID`,
        [`ALTER TABLE "t" DROP CONSTRAINT IF EXISTS "k_longer"`],
        false,
      ],
      [
        `ALTER TABLE public."t" ADD CONSTRAINT k CHECK (true) NOT VALID`,
        [`ALTER TABLE "t" DROP CONSTRAINT IF EXISTS "k"`],
        true,
      ],
      [
        `CREATE POLICY "p" ON "t" FOR SELECT TO r USING (true)`,
        [`DROP POLICY IF EXISTS "p" ON "other"`],
        false,
      ],
      [
        `CREATE POLICY "p" ON "t" FOR SELECT TO r USING (true)`,
        [`DROP POLICY IF EXISTS "p_longer" ON "t"`],
        false,
      ],
      [
        `CREATE TRIGGER "g" AFTER INSERT ON "t" FOR EACH ROW EXECUTE FUNCTION f()`,
        [`DROP TRIGGER IF EXISTS "g" ON "other"`],
        false,
      ],
      [
        `CREATE TRIGGER "g" AFTER INSERT ON "t" FOR EACH ROW EXECUTE FUNCTION f()`,
        [`DROP TRIGGER IF EXISTS "g_longer" ON "t"`],
        false,
      ],
      [
        `CREATE TRIGGER "g" AFTER INSERT ON "t" FOR EACH ROW EXECUTE FUNCTION f()`,
        [`DROP TRIGGER IF EXISTS "g" ON "t"`],
        true,
      ],
    ];
    for (const [statement, earlier, expected] of cases) {
      expect({
        statement,
        replaySafe: isReplaySafeBeforeSplit(statement, earlier),
      }).toEqual({ statement, replaySafe: expected });
    }
  });
});

describe("entity feature gate migration semantics", () => {
  test("approves only the idempotent NOT VALID gate constraint procedure", () => {
    const relativePath = ENTITY_FEATURE_GATE_MIGRATION;
    const valid =
      "DO $check$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.entities'::regclass AND conname = 'entity_feature_gate_states_check') THEN ALTER TABLE public.\"entities\" ADD CONSTRAINT entity_feature_gate_states_check CHECK (entity_feature_gate IN ('pending', 'open', 'legal-lists', 'missing')) NOT VALID; END IF; END $check$";
    const wrongRelation = valid.replaceAll("public.entities", "public.other");
    const wrongCheck = valid.replaceAll(
      "'pending', 'open', 'legal-lists', 'missing'",
      "'pending', 'open'",
    );
    const injectedUpdate = valid.replace(
      "END IF;",
      "UPDATE public.entities SET entity_feature_gate = 'open'; END IF;",
    );

    expect(isUnapprovedProceduralStatement(relativePath, valid)).toBe(false);
    expect(isUnapprovedProceduralStatement(relativePath, wrongRelation)).toBe(
      true,
    );
    expect(isUnapprovedProceduralStatement(relativePath, wrongCheck)).toBe(
      true,
    );
    expect(isUnapprovedProceduralStatement(relativePath, injectedUpdate)).toBe(
      true,
    );
    expect(isUnapprovedProceduralStatement("other/migration.sql", valid)).toBe(
      true,
    );
  });

  test("does not treat stored function bodies or policy checks as row scans", () => {
    expect(
      isRowScanningStatement(
        "fixture/migration.sql",
        "CREATE OR REPLACE FUNCTION gate() RETURNS void LANGUAGE plpgsql " +
          "AS $f$ BEGIN UPDATE public.items SET value = 1; END $f$",
      ),
    ).toBe(false);
    expect(
      isRowScanningStatement(
        "fixture/migration.sql",
        "CREATE POLICY gate_policy ON public.items AS RESTRICTIVE FOR ALL " +
          "USING (true) WITH CHECK (value > 0)",
      ),
    ).toBe(false);
    expect(
      isRowScanningStatement(
        "fixture/migration.sql",
        "ALTER TABLE public.items ADD CONSTRAINT positive_check " +
          "CHECK (value > 0) NOT VALID",
      ),
    ).toBe(false);
    expect(
      isRowScanningStatement(
        "fixture/migration.sql",
        "ALTER TABLE public.items ADD CONSTRAINT positive_check " +
          "CHECK (value > 0)",
      ),
    ).toBe(true);
    expect(
      isRowScanningStatement(
        "fixture/migration.sql",
        "ALTER TABLE public.items VALIDATE CONSTRAINT c",
      ),
    ).toBe(true);
    expect(
      isRowScanningStatement(
        "fixture/migration.sql",
        "ALTER DOMAIN public.positive_value ADD CONSTRAINT positive_check " +
          "CHECK (VALUE > 0)",
      ),
    ).toBe(true);
    expect(
      isRowScanningStatement(
        "fixture/migration.sql",
        "ALTER TABLE public.items ADD CHECK (value > 0)",
      ),
    ).toBe(true);
  });
});
