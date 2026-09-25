import { describe, expect, test } from "bun:test";

import {
  DYNAMIC_TOOL_NAMESPACES,
  dynamicToolNamespaceOf,
  namespaceMcpToolName,
  namespaceSkillToolName,
} from "@/api/lib/mcp-upstream/namespace";
import {
  DYNAMIC_TOOL_FAMILY_POLICIES,
  getDynamicMcpToolOutputContract,
} from "@/api/mcp/gateway/dynamic-tool-policy";
import { toMcpTools } from "@/api/mcp/gateway/list-tools";
import { MCP_CASING_RULE, MCP_INSTRUCTIONS } from "@/api/mcp/instructions";
import {
  ANONYMIZED_MCP_TOOL_DEFINITIONS,
  DEFAULT_MCP_TOOL_DEFINITIONS,
  DEFAULT_MCP_TOOL_SETS,
  getStaticMcpToolOutputContract,
  LAW_MCP_TOOL_DEFINITIONS,
} from "@/api/mcp/static-tool-definitions";
import type { McpToolDefinition } from "@/api/mcp/tool-types";
import { defineMcpToolOutput } from "@/api/mcp/valibot-tool-definition";

/**
 * Deterministic registry-quality suite (plan 046, goal c). Everything here is
 * a pure function of the static tool definitions: no model in the loop, no
 * network, no tokenizer. Budgets are character counts; characters approximate
 * tokens at roughly 4:1, so e.g. a 21_000-char payload is ~5k tokens.
 *
 * The budgets are ratchets: each ceiling sits ~10-15% above the measured
 * value at the time of writing, so organic growth fits but a surface-size
 * jump (new tools, longer descriptions) fails the suite and must be a
 * deliberate, reviewed constant bump.
 */

const SURFACES = [
  { mode: "default", definitions: DEFAULT_MCP_TOOL_DEFINITIONS },
  { mode: "anonymized", definitions: ANONYMIZED_MCP_TOOL_DEFINITIONS },
  { mode: "law", definitions: LAW_MCP_TOOL_DEFINITIONS },
] as const;

type SurfaceMode = (typeof SURFACES)[number]["mode"];

// Ceilings pinned to the measured counts after the tool-surface consolidation
// (plan 047): default 40 tools, anonymized 21 tools. The consolidation
// recovered five slots (40 -> 45); this ratchet makes every subsequent surface
// increase an explicit, reviewed decision rather than allowing silent growth.
// sits at the tighter measured 40 so unreviewed growth fails first. Any tool
// added to either surface must bump the matching ceiling deliberately.
// default bumped 40 -> 41 for the `prepare_feedback` tool (agent-drafted
// bug/feature/docs reports). It is excluded from the anonymized surface, so
// the anonymized ceiling is unchanged.
// default bumped 41 -> 44 for the three capability meta-tools (plan 049 phase 2:
// list_capabilities, describe_capability, invoke_capability). All three are
// excluded from the anonymized surface (two read-only meta-reads that expose a
// dynamic tenant payload, one write), so the anonymized ceiling is unchanged.
// default bumped 44 -> 45 for internal contact-directory discovery; the tool
// reuses the HTTP capability's query and remains excluded from anonymized mode.
// default bumped 45 -> 46 for save_filled_template: the one compound
// server-side persistence tool that removes raw PUT/base64 transport from agent
// workflows while keeping fill_template least-privileged. Further additions
// should recover a slot through consolidation before expanding this ceiling.
// default bumped 46 -> 47 for upload_document_version, the canonical
// host-file/MCP-App entry point backed by the existing version-upload pipeline.
// default bumped 47 -> 48 to split the host-file data tool from its portable
// picker launcher; UI metadata is static, so a combined tool rendered the
// picker even after a host-provided file had already uploaded successfully.
// default bumped 48 -> 49 for delete_task: tasks were the one workspace entity
// deletable over HTTP but not through MCP (delete_document refuses them by
// kind), so agents and the CLI had no way to remove one. Write-only, so the
// anonymized ceiling is unchanged.
// default bumped 49 -> 50 when save_template split into create_template and
// configure_template_fields: creating a template from a DOCX and configuring
// its fields are separate intents with separate permissions, and one tool
// advertising both branches made every property conditional on the other.
// Write-only, so the anonymized ceiling is unchanged.
// default bumped 50 -> 51 and anonymized 21 -> 22 for read_case_law_citations:
// the citation graph with each citing court's treatment and the paragraph the
// citation sits in. read_case_law_decision could not absorb it without
// becoming a tool whose meaning depends on which optional arguments are
// present, and the orientation eval showed a model reaching for the decision
// read and never finding the treatment.
// default bumped 51 -> 55 and anonymized 22 -> 26 for the four legislation
// corpus tools: corpus legislation search, point-in-time statute read, batch
// provision read, and provision history. They are four intents, not one tool
// with a mode argument: a search answers "which act", a read answers "what did
// it say on this date", the batch read answers "these provisions" without a
// call per provision, and the history answers "what changed". All four are
// public-corpus `passthrough`, so both surfaces carry them. The BOE rename
// (search_legislation -> search_boe_legislation) is count-neutral.
// law is pinned at its exact measured 7. That audience exists because host
// guidance puts a workable budget at 25-30 tools per agent while the default
// surface lists 55, so a growing law list defeats its own purpose: an eighth
// tool is argued for here, not absorbed.
// default 55 -> 56, anonymized 26 -> 27 and law 7 -> 8 for lookup_case_law:
// resolving a case reference to a decision is a different intent from
// searching for one, and search_case_law could not absorb it without becoming
// a tool whose meaning depends on which argument is present. It answers from
// the identity columns, so its failure modes (no such docket, a docket used at
// two courts) are not a ranking's.
// law 8 -> 10 for the OpenAI-compatible `search`/`fetch` pair. Argued for, not
// absorbed: a client that can only drive those two names (an OpenAI-compatible
// connector outside developer mode) could not reach the corpus at all, and the
// eight named tools are unreachable to it however short the list is. The
// default and anonymized counts are unchanged, because that audience already
// carried the pair.
// default 56 -> 57 and anonymized 27 -> 28 for preview_template_conditions.
// Argued for, not absorbed: fill_template settles an AI-decided condition and
// writes the document in one call, so asking what a set of values would decide
// cannot be a mode of it without the fill becoming a tool whose meaning depends
// on which argument is present. It also runs only the decision model, which is
// a different cost and a different failure set from a fill. law does not carry
// templates.
// default 57 -> 58 for save_playbook. Argued for, not absorbed: playbooks were
// readable and runnable from the curated list but writable only through
// invoke_capability, which in-app chat does not project, so no chat could
// author one. It cannot be a mode of save_clause (a different object with a
// different permission) or of run_playbook (a write to the definition versus a
// review over a matter). Write-only, so the anonymized ceiling is unchanged.
// default 58 -> 59 for compare_documents. Argued for, not absorbed: producing
// a redline was reachable only as a capability, so an agent asked to compare
// two versions had to discover it through list_capabilities first. It is not a
// mode of save_document or upload_document_version: it reads two stored
// versions, runs the DOCX comparison, and may write a derived version, which
// is a different cost and a different failure set from either. The anonymized
// count is unchanged; a write never appears there.
// default 59 -> 60 for prepare_file_comparison. Argued for, not absorbed: an
// agent handed two .docx files that are not in stella has no way to get bytes
// to the server, and compare_documents cannot take them inline because a DOCX
// does not fit a tool call. Reserving the upload is a separate call because the
// client PUTs between the two, and folding it into compare_documents would make
// that tool's meaning depend on whether files were attached. The anonymized
// count is unchanged; a write never appears there.
// open_file_comparison and prepare_file_comparison_from_links are separate
// tools, not modes of prepare_file_comparison: a chat host gives the model no
// way to PUT bytes, so the panel moves them from the user's browser and the
// links tool moves them server-side, each with its own failure set. Writes,
// so the anonymized count is unchanged.
// default 62 -> 63 for submit_feedback. Argued for, not absorbed: the draft
// step must stay read-only and send nothing, because showing the human the
// sanitized text before it leaves the workspace is the whole control. One tool
// doing both would put the model, alone, in charge of that decision. Write-only
// and excluded from the anonymized surface, so that ceiling is unchanged; law
// carries no feedback tool.
// default 63 -> 67 and anonymized 28 -> 29 for the reader-annotation tools:
// list, create, update and delete a highlight or comment on a decision or a
// statute. Separate tools, one intent each: create places a mark from an
// anchor and a quote and reports per-passage issues, update names one change,
// delete is destructive and confirmed. Only the list is a read, so only it
// reaches the anonymized surface.
const TOOL_COUNT_CEILING: Record<SurfaceMode, number> = {
  default: 67,
  anonymized: 29,
  law: 10,
};

// Serialized `tools/list` tool array (the wire payload produced by
// `toMcpTools`). Measured after plan 047: default 45_339 chars (~11.3k tokens),
// anonymized 19_472 chars (~4.9k tokens). Ceilings sit ~10-15% above so organic
// growth fits but a surface-size jump must be a deliberate constant bump.
// default bumped 51_000 -> 54_000 for the three capability meta-tools (plan 049
// phase 2): measured 51_580 chars. The anonymized surface is unchanged (all
// three are excluded from it).
// default bumped 54_000 -> 61_000 after contact discovery and template
// persistence brought the measured payload to 55_283 chars.
// default bumped 61_000 -> 70_000 after the template authoring tool began advertising the
// canonical strict field-configuration contract instead of a loose object
// approximation: measured 63_213 chars. The new ceiling retains roughly 10%
// review headroom without weakening the provider-visible schema.
// anonymized bumped 22_000 -> 23_403, exactly the measured growth from deriving
// every advertised schema from its runtime validator: +609 chars of
// `additionalProperties`, +682 of `minLength`/`format` bounds the handlers
// already enforced, +112 of explicit empty `required` lists. Stripping those
// three keyword classes reproduces the previous payload byte for byte, so no
// description, enum or property grew; the default surface still fits its
// ceiling unchanged.
// anonymized bumped 23_403 -> 23_557 when the scoping input was renamed and an
// alias clause was added per field; the alias is gone, so the payload sits
// below that again and the ceiling keeps the headroom.
// default bumped 70_000 -> 70_100 for delete_task plus the uuid format on
// entity ids and the task status/priority enums: measured 70_059 chars.
// default bumped 70_100 -> 70_200 when the template authoring tool gained the
// host file reference (the same four-property object upload_document_version
// advertises): measured 70_171 chars, and the tool description shrank to pay
// part of it back.
// default bumped 70_200 -> 71_000 when save_template split into
// create_template and configure_template_fields: two tool entries replace
// one, and each carries only the properties its own intent uses.
// Folding the six mutually exclusive derived-source keys into one `source`
// union then paid part of that back: the union's structure costs more than
// the flat keys did, but its per-branch prose belongs in the field-reference
// resource rather than in a schema every client downloads on connect, and
// the two tool descriptions lost the sentences the references already carry.
// Measured with both changes in: 70_849 chars.
// default bumped 71_000 -> 72_000 when create_template became an upsert:
// `template_id` plus the rules that say what it means with and without a
// document. Measured 71_254 chars, after list_templates gave back the fill
// semantics its own description was repeating from fill_template.
// Explicit destructive/read-only hints on every tool add only their required
// wire metadata: measured 72_683 default and 23_758 anonymized. Pin the exact
// new sizes so this submission fix does not create unrelated growth headroom.
// Shared agent-input metadata and generated guidance, plus explicit date
// formats on the case-law range, measure 72_962 default and 23_790 anonymized.
// Pin those exact sizes so future schema growth remains reviewable.
// read_case_law_citations and the case-law search filters it sits beside
// (`sort`, plus the hit fields and facet semantics the search description now
// states) measure 118_752 default and 54_752 anonymized: the citation
// passage says whether it was cut and which mention of the cited case it
// carries, and the search sort names the identifier lookup that ignores it.
// The citation tool's own description paid part of that back. Pin those exact
// sizes so the next schema growth stays reviewable.
// The four legislation corpus tools measure 130_210 default and 66_210
// anonymized, from 118_768 and 54_768 without them (the BOE rename accounts
// for the difference from the 118_752 pinned above). The cost is the ELI,
// anchor and as_of prose each tool repeats, and the batch read's nested
// `items[]` object; the alternative was one legislation tool whose meaning
// depended on which optional arguments were present. Pin those exact sizes so
// the next schema growth stays reviewable.
// default 130_300 -> 130_800 and anonymized 66_300 -> 66_800 (measured
// 130_753 and 66_753) for two contract facts the batch provision read owes a
// model: that a subdivision anchor is accepted, and that an entry is
// validated on its own so a malformed one comes back with its own status
// instead of sinking the call.
// law is pinned exactly: what a client downloads on connect is the property
// this audience sells, so growth here is the thing being ratcheted, not an
// incidental cost. It carries the same four legislation schemas, so the two
// facts above account for its size too.
// Every surface drops 66 chars when search_legislation stops cross-referencing
// search_boe_legislation: the corpus is jurisdiction-agnostic, and the law
// audience does not carry the connector at all, so following that sentence
// there answered unknown_tool. Measured 130_687, 66_687 and 22_001; the two
// wider ceilings keep the same 47-char margin they were set with, and law
// stays pinned exactly.
// The case-law batch cutover (search takes `queries[]`, the decision read
// takes `decision_ids[]`, and the case-law `country` input names the admitted
// codes) then measures 130_130 default, 66_130 anonymized and 21_444 law, down
// from 130_687, 66_687 and 22_001: the array inputs cost less than the prose
// the two descriptions gave back. Tightened to the new measurement, since a
// ratchet only moves down without a reviewed reason.
// Saying what the merged cursor does and does not carry costs 188 of those
// characters back: that its deduplication is within the page, and that a
// caller paging keys on `decisionId`. Neither is inferable from the shape, and
// a client that assumed otherwise would drop results silently. Measured
// 130_318 default, 66_318 anonymized and 21_632 law.
// lookup_case_law then measures 132_709 default, 68_709 anonymized and 24_023
// law, up 2_391 on every surface: its own input schema, its description, and
// an output schema whose four branches each say what the caller does next. The
// fourth keeps a reference whose read failed from taking the batch down with
// it.
// Naming that fourth status in the description measures 24_053 law, up 30
// after trimming the same description elsewhere: a caller reading
// `lookup_failed` as an unknown status would retry the whole batch instead of
// the one reference whose read did not complete. The wider surfaces absorb it
// in their existing headroom.
// Binding the four country inputs to the lenient country reader costs the
// rest: each carries the `x-stella-agent-input` marker dispatch reads, plus one
// sentence saying an alpha-3 or alpha-2 code or the country's name is accepted.
// Both are what a model needs to spell the value at all: capped at three
// characters, `country` answered a Czech request for Czech case law with
// `not_found`, and the model answered from memory instead of from the corpus.
// The marker also carries the admitted codes and the tool name so a rejection
// names the call to change rather than only the field that was wrong.
// Measured 133_357 default, 69_168 anonymized and 24_482 law.
// Reporting what a search required then measures 134_215 default, 69_996
// anonymized and 25_198 law, on top of the country reader above: search_case_law
// gains a `strict` input and the sentence saying function words are not
// required terms, and the descriptions of its filters and of
// read_case_law_citations were trimmed to pay part of it back. A model that
// cannot see which words were required reads an empty page as an empty corpus.
// The corpus reaching the OpenAI-compatible pair then measures 135_038
// default, 70_857 anonymized and 28_194 law. The wider surfaces pay for the id
// vocabulary both descriptions state and for the `fetch` id pattern that
// replaces a bare uuid format; law pays for the pair itself, which is what the
// audience gained. A vocabulary a model cannot see is a vocabulary it guesses,
// and a guessed id is a not_found the model reads as an empty corpus.
// list_tasks listing across matters then measures 135_328 default and 71_147
// anonymized: matter_id turns optional and the tool gains the `assignee`
// filter, and the description has to say that omitting the matter widens the
// list, or a model keeps asking which matter to look in.
// Reporting condition decisions adds preview_template_conditions plus the
// sentence fill_template needs about `decisions`. An agent reading a filled
// template's paragraphs cannot tell a block excluded by a decision from one the
// document never carried, so what was decided has to be said rather than
// inferred. Law is unchanged; it carries no template tool.
// save_playbook then measures 145_426 default, up 7_308 from 138_118: its
// entry is 7_307 chars, of which the input schema is 5_559. The stored
// `positionSchema` serializes to 32_190, so the tool advertises its own
// snake_case position input instead: no rule or entry ids, no derived ask, no
// deterministic check and no reference standard (all server-owned or
// editor-only), a flat ladder (which also keeps the schema under the CLI's
// depth cap), one-line field descriptions, and the authoring grammar left to
// the skill rather than repeated per field. Pinned exactly. Anonymized and law
// do not carry the tool.
// compare_documents adds 4_712 (measured on its own from 138_119 to 142_831):
// 2_712 of that is its input schema, whose `source` union states each
// selection's own version ids rather than a set of optional ones a model could
// fill contradictorily, and whose description says what each tracked-changes
// disposition compares. prepare_file_comparison and the `uploads` source add
// 3_853 more: about 2_100 is the new tool (two file descriptors, each stating
// the size limit and what the checksum is of, plus a description that spells
// out the PUT and the call after it), and the rest is compare_documents' third
// source variant and the third output_mode its description distinguishes.
// Measured 154_051 default. Anonymized and law are unchanged: both tools are
// writes, so neither surface carries them.
// open_file_comparison (no input, a short description) and
// prepare_file_comparison_from_links (two link descriptors) sit under the
// default ceiling with the usual headroom; writes, so the other surfaces are
// unchanged.
// submit_feedback then measures 163_346 default. Its schema repeats the
// sanitized fixed-point payload and adds the explicit human confirmation
// gate. The anonymized and law surfaces carry no feedback tools and are
// unchanged.
// The `mixed` citation treatment then measures 163_352 default, up 6: the
// closed polarity vocabulary gains a member in read_case_law_citations'
// output schema, and its description was shortened to pay for most of it.
// A value the column can hold has to be a value the schema admits, so this
// is not compressible; the anonymized and law surfaces keep their headroom.
// The feedback approval token then measures 163_588 default: submit_feedback
// takes the approval_token prepare_feedback signs over the report, so the
// report the human approved and the one that is sent cannot diverge. Both
// descriptions were shortened to pay for part of it; feedback tools are not on
// the anonymized or law surfaces.
// The four reader-annotation tools then measure 172_122 default and 75_306
// anonymized (the list alone reaches the anonymized surface). Most of it is
// create's input: the discriminated mark and the anchored passages the server
// places the mark by.
// Projecting the last six hand-written input schemas from their validators
// then adds 161 default: the projection states bounds and defaults the
// validators already enforced (`minLength`, the cursor's `maxLength`,
// `access`/`limit` defaults) plus Valibot's empty `required`.
// save_playbook's `scope.perspective` then measures 172_389 default: the description
// now says when the side maps to no value (a recipient, controller, or
// customer), so the rule holds for a caller without the playbook-builder
// skill. Small models set a value on every side without it. The knowledge
// tools are not on the anonymized or law surfaces.
const TOOLS_LIST_PAYLOAD_CHAR_CEILING: Record<SurfaceMode, number> = {
  default: 172_500,
  anonymized: 75_400,
  law: 28_250,
};

// default bumped 42_000 -> 42_300 for the two fields read_case_law_citations
// adds to each passage (`truncated`, and the closed `mention` set): a model
// reading an excerpt as the whole paragraph, or a passage as the mention the
// treatment was classified from, is reading something the data does not say.
// Measured 42_212. The anonymized surface does not carry this tool.
// default bumped 42_300 -> 46_400 and anonymized 28_000 -> 32_000 for the
// four legislation corpus schemas: measured 46_280 default (42_212 without
// them) and 31_916 anonymized (27_848 without them). Their largest, 1_416 for
// read_statute, is well under the per-tool ceiling; it declares the outline
// entries, the version window and the withheld-text field, each of which says
// something the data would otherwise be read as promising.
// default 46_400 -> 46_600 and anonymized 32_000 -> 32_300 (measured 46_525
// and 32_161) for the two branches the provision reads gained: an `invalid`
// entry carrying its own `issues[]`, and a history item discriminated on the
// same status vocabulary so a version whose source bars derived AI use
// answers `text_withheld` rather than its wording. law carries the same
// schemas and is pinned exactly.
// The case-law batch cutover then measures 44_960 default, 30_596 anonymized
// and 7_733 law, down from 46_525, 32_161 and 9_298: the decision read
// declares its decision once inside an `items[]` variant whose absence
// branches are three fields each, and search_case_law adds only
// `matchedQueries`. Tightened to the new measurement.
// lookup_case_law then measures 45_807 default, 31_443 anonymized and 8_580
// law, up 847: the identity fields are declared once and shared between the
// `found` entry and an `ambiguous` entry's candidates, so the two remaining
// branches cost a message, a hint, and the `lookup_failed` entry that keeps a
// failed reference from taking the batch down with it.
// search_case_law's `searches[]` then measures 46_098 default, 31_734
// anonymized and 8_871 law, up 291: one entry per phrasing carrying the query
// as sent, the `queryUsed` the engine answered, and that phrasing's warnings.
// Per phrasing rather than per call because each is interpreted on its own,
// and a caller that cannot tell which phrasing was widened cannot act on it.
// The compat `fetch` metadata then measures 46_223 default, 31_859 anonymized
// and 9_981 law. It is a discriminated union on `kind` rather than one object:
// only a matter document belongs to a workspace, so a strict object with an
// optional `workspaceId` would let a corpus read answer with a tenant field.
// Law also gains the pair's two schemas, its `fetch` union carrying the two
// corpus branches alone.
// list_tasks rows then name their matter (`matterId`, `matterName`,
// `matterReference`): a list spanning matters is unreadable when a row cannot
// say which matter it is in. Condition decisions add one decided/undecided
// variant, shared by preview_template_conditions and fill_template, plus the
// `{% if %}` block list's `kind` variant. A decided `false` and a condition
// nothing could settle exclude the same paragraph, so they cannot share one
// shape. Adding `decided_by` provenance for supplied values measures 48_033
// default and 32_831 anonymized after merging the structurally identical user
// and generative branches; without it, an agent cannot tell an override from a
// model answer.
// save_playbook's output then measures 48_916 default, up 883: the `updatedAt`
// the next save passes back, each written position's `sourceId` with whether
// it was added or changed, and the per-entry `issues[]` that lets one refused
// position come back with its fix while the rest of the call is saved.
// compare_documents adds 988: one result per target, discriminated on
// `status`, carrying the change counts, the saved version and its links. The
// changes themselves are deliberately not in it, since that list grows with the
// document and is the document rather than a report on it. The staged-upload
// path adds 1_321: three result variants naming upload ids rather than version
// ids, because echoing an upload id back as `baseVersionId` would invite a call
// that cannot resolve, plus prepare_file_comparison's own output, which is two
// signed PUTs and the next call spelled out. Measured 51_274 default.
// Anonymized and law are unchanged.
// prepare_file_comparison_from_links echoes the same next call plus the two
// derived names and sizes; open_file_comparison returns nothing. Writes, so
// the other surfaces are unchanged.
// submit_feedback adds the receipt, per-channel delivery outcomes and the
// no-channel warning: measured 53_449 default. The anonymized and law surfaces
// are unchanged.
// The `mixed` citation treatment adds 8 to read_case_law_citations' polarity
// enum: measured 53_457 default. A closed vocabulary that omits a value the
// column holds would have the tool answer outside its own schema, so the
// member is not optional and the ceiling moves rather than the enum. The
// anonymized and law surfaces carry the same schema inside their headroom.
// prepare_feedback returns the approval_token submit_feedback requires:
// measured 53_509 default. The anonymized and law surfaces are unchanged.
// The reader-annotation tools add the listed marks with their passages, the
// created mark's stored passages, and two receipts: measured 55_085 default and
// 33_799 anonymized, where the list is the only one of them.
const OUTPUT_SCHEMA_TOTAL_CHAR_CEILING: Record<SurfaceMode, number> = {
  default: 55_150,
  anonymized: 33_850,
  law: 10_050,
};

// Largest measured schema is read_document at 3_434 chars. A single tool must
// not consume an unreviewed multi-thousand-token block of every tools/list.
const OUTPUT_SCHEMA_CHAR_CEILING = 4000;

// Longest description measured after plan 047: the template authoring tool at
// 724 chars (~180 tokens), 807 after it documented the file transport. Ceiling
// keeps a little headroom above that.
const TOOL_DESCRIPTION_CHAR_CEILING = 810;

// verb_noun style: lowercase words joined by single underscores.
const TOOL_NAME_PATTERN = /^[a-z]+(?:_[a-z]+)*$/u;

// Display titles: start with an uppercase letter, end without a period or
// whitespace, and contain at least one lowercase letter (sentence case, not
// shouting; the lowercase check lives in the test since a regex cannot say
// "not fully uppercase" readably). Internal punctuation is allowed. The
// 40-char product cap sits under the CLI trust boundary's 64-unit wire cap
// (MAX_TOOL_TITLE_CHARS in packages/cli/src/registry-trust.ts), so every
// title the registry can emit is also one a fetched listing would accept.
const TOOL_TITLE_MAX_CHARS = 40;
const TOOL_TITLE_PATTERN = /^[A-Z].*[^.\s]$/u;

describe.each([...SURFACES])(
  "MCP registry quality ($mode surface)",
  ({ mode, definitions }) => {
    test("tool surface snapshot (name, scope, description, annotations, inputSchema)", () => {
      // Any change to the advertised surface shows up as a reviewable
      // snapshot diff. Registry order is the advertised wire order, so
      // reorders are surface changes too.
      expect(serializeToolSurface(definitions)).toMatchSnapshot();
    });

    test("tool count stays under the ceiling", () => {
      expect(definitions.length).toBeLessThanOrEqual(TOOL_COUNT_CEILING[mode]);
    });

    test("serialized tools/list payload stays under the character budget", () => {
      const payloadChars = JSON.stringify(toMcpTools(definitions)).length;
      expect(payloadChars).toBeLessThanOrEqual(
        TOOLS_LIST_PAYLOAD_CHAR_CEILING[mode],
      );
    });

    test("output schemas stay within total and per-tool budgets", () => {
      let total = 0;
      for (const tool of toMcpTools(definitions)) {
        const chars = JSON.stringify(tool.outputSchema).length;
        total += chars;
        expect(
          chars,
          `Tool ${tool.name} output schema is ${chars} chars`,
        ).toBeLessThanOrEqual(OUTPUT_SCHEMA_CHAR_CEILING);
      }
      expect(total).toBeLessThanOrEqual(OUTPUT_SCHEMA_TOTAL_CHAR_CEILING[mode]);
    });

    test("every tool description fits the per-tool character budget", () => {
      for (const tool of definitions) {
        expect(
          tool.description.length,
          `Tool ${tool.name} description is ${tool.description.length} chars`,
        ).toBeLessThanOrEqual(TOOL_DESCRIPTION_CHAR_CEILING);
      }
    });

    test("tool names follow verb_noun naming", () => {
      for (const tool of definitions) {
        expect(tool.name).toMatch(TOOL_NAME_PATTERN);
      }
    });

    test("tool titles are unique, sentence-case display names", () => {
      const seen = new Map<string, string>();
      for (const tool of definitions) {
        const title = tool.annotations.title;
        expect(title, `Tool ${tool.name} title "${title}"`).toMatch(
          TOOL_TITLE_PATTERN,
        );
        expect(
          title,
          `Tool ${tool.name} title "${title}" is fully uppercase`,
        ).not.toBe(title.toUpperCase());
        expect(
          title.length,
          `Tool ${tool.name} title is ${title.length} chars`,
        ).toBeLessThanOrEqual(TOOL_TITLE_MAX_CHARS);
        const holder = seen.get(title);
        expect(
          holder === undefined
            ? undefined
            : `Tools ${holder} and ${tool.name} share the title "${title}"`,
        ).toBeUndefined();
        seen.set(title, tool.name);
      }
    });

    test("every tool description is non-empty and starts with a capital letter", () => {
      for (const tool of definitions) {
        expect(
          tool.description,
          `Tool ${tool.name} description must start with a capital letter`,
        ).toMatch(/^[A-Z]/u);
      }
    });

    test("every input schema property has a non-empty description", () => {
      const issues: string[] = [];
      for (const tool of definitions) {
        collectUndescribedProperties(tool.inputSchema, tool.name, issues);
      }
      expect(issues).toEqual([]);
    });

    test("every advertised object schema states its unknown-key policy", () => {
      const issues: string[] = [];
      for (const tool of definitions) {
        collectOpenObjectSchemas(tool.inputSchema, tool.name, issues);
      }
      expect(
        issues,
        `These advertised object schemas leave additionalProperties undeclared, so a client cannot tell whether a typo errors or is ignored: ${issues.join(", ")}. Derive the schema from the v.strictObject its handler parses (defineValibotMcpTool) for additionalProperties: false, or declare additionalProperties: true explicitly for a map whose keys are caller data.`,
      ).toEqual([]);
    });

    test("list_* and search_* tools accept a cursor; limit implies cursor", () => {
      for (const tool of definitions) {
        const properties = getInputProperties(tool);
        const isPaged =
          tool.name.startsWith("list_") || tool.name.startsWith("search_");
        if (isPaged || "limit" in properties) {
          expect(
            Object.keys(properties),
            `Tool ${tool.name} must accept a cursor input`,
          ).toContain("cursor");
        }
      }
    });
  },
);

/**
 * `access` (plan 048 prerequisite: the chat code-mode projection selects
 * read-only tools structurally by this field) must stay coherent with the two
 * older, narrower signals that already implied a tool's mutation status:
 * MCP client-hint `annotations` and the anonymized-surface exclusion reason.
 * These are deterministic cross-checks over the static registry, not
 * per-tool assertions, so a new tool cannot silently declare `access` at odds
 * with either signal.
 */
// Widened to `McpToolDefinition` (which makes `annotations` a uniformly
// optional key) so the coherence checks below can destructure freely; the
// exported `as const satisfies` registry keeps each element's narrower
// literal type, which does not have `annotations` at all on tools that omit
// it and fails these checks' property access at the type level.
const defaultTools: readonly McpToolDefinition[] = DEFAULT_MCP_TOOL_DEFINITIONS;
const anonymizedTools: readonly McpToolDefinition[] =
  ANONYMIZED_MCP_TOOL_DEFINITIONS;

describe("MCP registry access coherence", () => {
  test('every access: "write" tool carries readOnlyHint false', () => {
    for (const tool of defaultTools) {
      if (tool.access === "write") {
        expect(
          tool.annotations.readOnlyHint,
          `Tool ${tool.name} is access: "write" but does not declare readOnlyHint false`,
        ).toBe(false);
      }
    }
  });

  test('every access: "read" tool carries readOnlyHint', () => {
    // The converse of the check above, and the reason it matters: a client that
    // auto-approves read-only tools prompts for a read tool that omits the hint.
    for (const tool of defaultTools) {
      if (tool.access === "read") {
        expect(
          tool.annotations.readOnlyHint,
          `Tool ${tool.name} is access: "read" but omits readOnlyHint`,
        ).toBe(true);
      }
    }
  });

  test('destructiveHint tools are always access: "write"', () => {
    for (const tool of defaultTools) {
      if (tool.annotations.destructiveHint) {
        expect(
          tool.access,
          `Tool ${tool.name} carries destructiveHint but is not access: "write"`,
        ).toBe("write");
      }
    }
  });

  test('anonymized-exclusion reason "write" and access: "write" imply each other', () => {
    for (const tool of defaultTools) {
      const isWriteExcluded =
        tool.anonymized.exposure === "excluded" &&
        tool.anonymized.reason === "write";
      if (isWriteExcluded) {
        expect(
          tool.access,
          `Tool ${tool.name} is anonymized-excluded for "write" but is not access: "write"`,
        ).toBe("write");
      }
      if (tool.access === "write") {
        expect(
          isWriteExcluded,
          `Tool ${tool.name} is access: "write" but is not anonymized-excluded with reason "write"`,
        ).toBe(true);
      }
    }
  });

  test('access: "write" tools are absent from the anonymized surface', () => {
    const anonymizedNames = new Set(anonymizedTools.map((tool) => tool.name));
    for (const tool of defaultTools) {
      if (tool.access === "write") {
        expect(
          anonymizedNames.has(tool.name),
          `Tool ${tool.name} is access: "write" but appears on the anonymized surface`,
        ).toBe(false);
      }
    }
  });
});

/**
 * The two behavioural MCP annotations (`openWorldHint`, `idempotentHint`) must
 * be declared coherently with each tool's `access` classification, so an agent
 * client reasoning off the hints can never be misled by a missing or
 * contradictory declaration. Like the access-coherence block above, these are
 * deterministic cross-checks over the static registry: a new tool that omits
 * `openWorldHint`, forgets `idempotentHint` on a write, declares it on a read,
 * or ships a `delete_*` that is not idempotent fails the build.
 */
describe("MCP registry annotation coherence", () => {
  test("every tool declares destructiveHint explicitly (boolean)", () => {
    for (const tool of defaultTools) {
      expect(
        typeof tool.annotations.destructiveHint,
        `Tool ${tool.name} must declare annotations.destructiveHint explicitly`,
      ).toBe("boolean");
    }
  });

  test("every tool declares openWorldHint explicitly (boolean)", () => {
    for (const tool of defaultTools) {
      expect(
        typeof tool.annotations.openWorldHint,
        `Tool ${tool.name} must declare annotations.openWorldHint explicitly`,
      ).toBe("boolean");
    }
  });

  test('every access: "write" tool declares idempotentHint explicitly (boolean)', () => {
    for (const tool of defaultTools) {
      if (tool.access !== "write") {
        continue;
      }
      expect(
        typeof tool.annotations.idempotentHint,
        `Tool ${tool.name} is access: "write" but does not declare annotations.idempotentHint`,
      ).toBe("boolean");
    }
  });

  test('read-only (access: "read") tools do not declare idempotentHint', () => {
    for (const tool of defaultTools) {
      if (tool.access !== "read") {
        continue;
      }
      expect(
        tool.annotations.idempotentHint,
        `Tool ${tool.name} is access: "read"; idempotentHint is meaningless and must be omitted`,
      ).toBeUndefined();
    }
  });

  test("every delete_* tool is idempotentHint true", () => {
    for (const tool of defaultTools) {
      if (!tool.name.startsWith("delete_")) {
        continue;
      }
      expect(
        tool.annotations.idempotentHint,
        `Tool ${tool.name} is a delete_* tool and must be idempotentHint true`,
      ).toBe(true);
    }
  });

  test("the anonymized projection carries annotations through unchanged", () => {
    const defaultByName = new Map(
      defaultTools.map((tool) => [tool.name, tool]),
    );
    for (const tool of anonymizedTools) {
      const source = defaultByName.get(tool.name);
      expect(
        source,
        `Anonymized tool ${tool.name} has no default-surface counterpart`,
      ).toBeDefined();
      if (!source) {
        continue;
      }
      expect(
        tool.annotations,
        `Anonymized tool ${tool.name} annotations diverge from the default surface`,
      ).toEqual(source.annotations);
    }
  });
});

/**
 * Advertised input property names. The anonymized surface is a projection of
 * the same definitions, so checking the default surface covers both.
 *
 * The set is exact and empty: every advertised name, at every depth, must be
 * snake_case. Payloads that mirror internal camelCase models (`save_clause`
 * body paragraphs, `configure_template_fields` field entries) carry their own snake_case
 * input schema and map onto the model at the tool boundary, so a new
 * camelCase name anywhere in an input fails here.
 */
const CAMEL_CASE_INPUT_PROPERTY_DEBT: string[] = [];

describe("MCP registry input naming", () => {
  test("input property names are snake_case at every depth", () => {
    const issues: string[] = [];
    for (const tool of defaultTools) {
      collectNonSnakeCaseProperties(tool.inputSchema, tool.name, issues);
    }
    expect([...new Set(issues)].toSorted()).toEqual(
      CAMEL_CASE_INPUT_PROPERTY_DEBT,
    );
  });

  // The other half of the same convention: inputs are snake_case, payloads are
  // camelCase. Property names are enforced structurally above; the payload half
  // cannot be, so every surface states the rule at connect time instead.
  test("every surface states the casing rule at connect time", () => {
    for (const [mode, instructions] of Object.entries(MCP_INSTRUCTIONS)) {
      expect(
        instructions,
        `The ${mode} instructions must state the snake_case-in/camelCase-out rule`,
      ).toContain(MCP_CASING_RULE);
    }
  });
});

describe("MCP static tool-set coherence", () => {
  test("each static tool set binds exactly one handler per advertised definition", () => {
    for (const toolSet of DEFAULT_MCP_TOOL_SETS) {
      const definitionNames = toolSet.definitions.map((tool) => tool.name);
      const handlerNames = Object.keys(toolSet.handlers);
      const outputNames = Object.keys(toolSet.outputs);

      expect(handlerNames.toSorted()).toEqual(definitionNames.toSorted());
      expect(outputNames.toSorted()).toEqual(definitionNames.toSorted());
    }
  });

  test("every static wire tool advertises its executable output contract", () => {
    const tools = toMcpTools(DEFAULT_MCP_TOOL_DEFINITIONS);
    for (const tool of tools) {
      const contract = getStaticMcpToolOutputContract(tool.name);
      expect(
        contract,
        `Missing output contract for ${tool.name}`,
      ).toBeDefined();
      expect(tool.outputSchema).toEqual(contract?.outputSchema);
    }
  });

  test("static tool names are unique across tool sets", () => {
    const names = DEFAULT_MCP_TOOL_DEFINITIONS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

const serializeToolSurface = (
  definitions: readonly McpToolDefinition[],
): string =>
  JSON.stringify(
    definitions.map(
      ({
        access,
        additionalScopes,
        annotations,
        description,
        feature,
        inputSchema,
        name,
        scope,
      }) => ({
        name,
        scope,
        additionalScopes,
        // Serialized so a change to a tool's read/write classification is a
        // visible snapshot diff, not a silent surface change.
        access,
        // Serialized so a change to a tool's deployment gate is a visible
        // snapshot diff, not a silent surface change.
        feature,
        description,
        annotations,
        inputSchema,
      }),
    ),
    null,
    2,
  );

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * Walks a JSON Schema and records the path of every named property (at any
 * nesting depth, including array `items`) whose `description` is missing or
 * blank. Collecting paths instead of asserting inline makes a failure name
 * every offending property at once.
 */
const collectUndescribedProperties = (
  schema: unknown,
  path: string,
  issues: string[],
): void => {
  if (!isRecord(schema)) {
    return;
  }
  if (isRecord(schema["properties"])) {
    for (const [key, property] of Object.entries(schema["properties"])) {
      const propertyPath = `${path}.${key}`;
      if (
        !isRecord(property) ||
        typeof property["description"] !== "string" ||
        property["description"].trim() === ""
      ) {
        issues.push(propertyPath);
      }
      collectUndescribedProperties(property, propertyPath, issues);
    }
  }
  collectUndescribedProperties(schema["items"], `${path}[]`, issues);
};

/**
 * Walks a JSON Schema and records the path of every object schema that leaves
 * unknown keys UNDECLARED. A client must be able to predict, from the
 * advertised schema alone, whether a typo is rejected or swallowed; silence is
 * the one answer it cannot act on. Three declarations are honest:
 * `additionalProperties: false` (the default for a curated tool),
 * `additionalProperties: { ... }` (a constrained map: every key validated), and
 * an explicit `additionalProperties: true` for an open map whose keys are
 * caller data, such as a template's field-path -> value map.
 */
const collectOpenObjectSchemas = (
  schema: unknown,
  path: string,
  issues: string[],
): void => {
  if (!isRecord(schema)) {
    return;
  }
  const isObjectSchema =
    schema["type"] === "object" || isRecord(schema["properties"]);
  const additionalProperties = schema["additionalProperties"];
  const declaresUnknownKeyPolicy =
    additionalProperties === false ||
    additionalProperties === true ||
    isRecord(additionalProperties);
  if (isObjectSchema && !declaresUnknownKeyPolicy) {
    issues.push(path);
  }
  if (isRecord(schema["properties"])) {
    for (const [key, property] of Object.entries(schema["properties"])) {
      collectOpenObjectSchemas(property, `${path}.${key}`, issues);
    }
  }
  if (isRecord(schema["patternProperties"])) {
    for (const property of Object.values(schema["patternProperties"])) {
      collectOpenObjectSchemas(property, `${path}[*]`, issues);
    }
  }
  collectOpenObjectSchemas(
    schema["additionalProperties"],
    `${path}[*]`,
    issues,
  );
  collectOpenObjectSchemas(schema["items"], `${path}[]`, issues);
  for (const keyword of ["anyOf", "allOf", "oneOf"]) {
    const branches = schema[keyword];
    if (Array.isArray(branches)) {
      for (const [index, branch] of branches.entries()) {
        collectOpenObjectSchemas(
          branch,
          `${path}<${keyword}[${index}]>`,
          issues,
        );
      }
    }
  }
};

// Advertised input property names: lowercase words joined by single
// underscores. The name is the one part of a tool contract an agent has to
// reproduce exactly, so a camelCase outlier (or a synonym for a name the rest
// of the surface already settled) is a correctness cost, not a style
// preference. `input-vocabulary.test.ts` guards the scoping name specifically.
const SNAKE_CASE_PROPERTY = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u;

/**
 * Walks every schema-bearing branch the CLI trust boundary admits
 * (`registry-trust.ts`) and records the path of each non-snake_case property.
 * Union branches share their parent's path, so one offending name is one
 * entry however many branches carry it.
 */
const collectNonSnakeCaseProperties = (
  schema: unknown,
  path: string,
  issues: string[],
): void => {
  if (!isRecord(schema)) {
    return;
  }
  if (isRecord(schema["properties"])) {
    for (const [key, property] of Object.entries(schema["properties"])) {
      const propertyPath = `${path}.${key}`;
      if (!SNAKE_CASE_PROPERTY.test(key)) {
        issues.push(propertyPath);
      }
      collectNonSnakeCaseProperties(property, propertyPath, issues);
    }
  }
  if (isRecord(schema["patternProperties"])) {
    for (const property of Object.values(schema["patternProperties"])) {
      collectNonSnakeCaseProperties(property, `${path}[*]`, issues);
    }
  }
  collectNonSnakeCaseProperties(
    schema["additionalProperties"],
    `${path}[*]`,
    issues,
  );
  collectNonSnakeCaseProperties(schema["items"], `${path}[]`, issues);
  for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
    const branches = schema[keyword];
    if (!Array.isArray(branches)) {
      continue;
    }
    for (const branch of branches) {
      collectNonSnakeCaseProperties(branch, path, issues);
    }
  }
};

const getInputProperties = (
  tool: McpToolDefinition,
): Record<string, unknown> =>
  isRecord(tool.inputSchema.properties) ? tool.inputSchema.properties : {};

describe("destructive write-tool behavior", () => {
  const writeTools: readonly McpToolDefinition[] =
    DEFAULT_MCP_TOOL_DEFINITIONS.filter((tool) => tool.access === "write");

  test("every destructiveHint write tool declares its executable behavior", () => {
    const offenders = writeTools
      .filter((tool) => tool.annotations.destructiveHint)
      .filter((tool) => tool.destructiveBehavior === undefined)
      .map((tool) => tool.name);
    expect(offenders).toEqual([]);
  });

  test("non-destructive tools declare no behavior except an outbound send", () => {
    const offenders = writeTools
      .filter((tool) => !tool.annotations.destructiveHint)
      .filter(
        (tool) =>
          tool.destructiveBehavior !== undefined &&
          tool.destructiveBehavior.type !== "outbound",
      )
      .map((tool) => tool.name);
    expect(offenders).toEqual([]);
  });

  test("an outbound send is never advertised as a destructive operation", () => {
    // The two facts are independent and must not be conflated: `outbound`
    // gates the confirmation prompt, `destructiveHint` tells a client to
    // render the call as a deletion. A send destroys nothing.
    const offenders = defaultTools
      .filter(
        (tool) =>
          tool.destructiveBehavior?.type === "outbound" &&
          tool.annotations.destructiveHint,
      )
      .map((tool) => tool.name);
    expect(offenders).toEqual([]);
  });

  test("an outbound tool states what it sends, and advertises confirm", () => {
    const outbound = defaultTools.filter(
      (tool) => tool.destructiveBehavior?.type === "outbound",
    );
    expect(outbound.length).toBeGreaterThan(0);

    for (const tool of outbound) {
      const behavior = tool.destructiveBehavior;
      expect(behavior?.type === "outbound" ? behavior.reason : "").toContain(
        tool.name,
      );
      expect(Object.keys(getInputProperties(tool))).toContain("confirm");
      // The refusal names `confirm: true`; a description that never mentions
      // it leaves a model to discover the gate by being refused.
      expect(tool.description).toContain("confirm: true");
    }
  });
});

/**
 * Dynamic tool families are resolved per account, so no static registry row
 * can carry their contract. The family policy map is the registry instead:
 * every namespaced family decides who owns its output contract, and a
 * Stella-owned family's advertised schema must be derived from the executable
 * source that validates its results at dispatch.
 */
describe("MCP dynamic tool-family coherence", () => {
  const namespaces = Object.keys(DYNAMIC_TOOL_NAMESPACES);

  test("every namespaced family has a policy and every policy names a family", () => {
    expect(Object.keys(DYNAMIC_TOOL_FAMILY_POLICIES).toSorted()).toEqual(
      namespaces.toSorted(),
    );
  });

  test("the namespace census classifies every generated tool name", () => {
    expect(
      dynamicToolNamespaceOf(namespaceSkillToolName("summarize-c4ec37")),
    ).toBe("skill");
    expect(
      dynamicToolNamespaceOf(
        namespaceMcpToolName({ connectorSlug: "registry", toolName: "lookup" }),
      ),
    ).toBe("external_mcp");
    expect(dynamicToolNamespaceOf("list_matters")).toBeUndefined();
  });

  test("every Stella-owned family derives its advertised schema from its runtime source", () => {
    for (const policy of Object.values(DYNAMIC_TOOL_FAMILY_POLICIES)) {
      if (policy.owner !== "stella") {
        continue;
      }
      expect(policy.output.projection).toBe("identity");
      expect(policy.output.outputSchema).toEqual(
        defineMcpToolOutput(policy.output.outputSchemaSource).outputSchema,
      );
    }
  });

  test("every Stella-owned family is read-only, non-destructive and closed-world", () => {
    for (const policy of Object.values(DYNAMIC_TOOL_FAMILY_POLICIES)) {
      if (policy.owner !== "stella") {
        continue;
      }
      expect(policy.annotations).toEqual({
        destructiveHint: false,
        openWorldHint: false,
        readOnlyHint: true,
      });
    }
  });

  test("only Stella-owned families resolve an output contract by name", () => {
    expect(
      getDynamicMcpToolOutputContract(
        namespaceSkillToolName("summarize-c4ec37"),
      ),
    ).toBe(DYNAMIC_TOOL_FAMILY_POLICIES.skill.output);
    expect(
      getDynamicMcpToolOutputContract(
        namespaceMcpToolName({ connectorSlug: "registry", toolName: "lookup" }),
      ),
    ).toBeUndefined();
    expect(getDynamicMcpToolOutputContract("list_matters")).toBeUndefined();
  });
});
