# @stll/cli

## 0.11.0

### Minor Changes

- [#2979](https://github.com/stella/stella/pull/2979) [`1ed653b`](https://github.com/stella/stella/commit/1ed653ba2c78b34f37e6a7af3b3c4765534e4cec) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Smooth out the first-session papercuts: a registry cache the current schema cannot read is rebuilt instead of skipped forever; unknown commands and flags exit 2 and auth failures exit 3 per the documented contract; a default login requests the working scope set; tables fit the terminal, drop empty columns, and flatten nested objects; tool errors name the flag instead of the wire field; `--input` accepts camelCase keys; help briefs use the tool's description, groups list their commands, and a Required line states each command's inputs; workspace-scoped capabilities all take `--workspace-id`; commands a deployment has gated off are marked in help and `tools list`; `upload` prints the finalized document like other saves; `auth whoami` says how long the session has left; `task delete` removes a task (new `delete_task` tool).

## 0.10.1

### Patch Changes

- [#2947](https://github.com/stella/stella/pull/2947) [`6f86823`](https://github.com/stella/stella/commit/6f86823e5e9eb4f2b2a8027a021063b909ca44e3) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Exhaustiveness checks panic instead of returning the unhandled value, and a
  fallback after the assertion counts as returning it.

- [#2948](https://github.com/stella/stella/pull/2948) [`ff290f9`](https://github.com/stella/stella/commit/ff290f9ac184d94bf739c508ef1e766e7459f388) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Cursor parameters on list capabilities carry the shared helper's description.

- [#2966](https://github.com/stella/stella/pull/2966) [`b65402c`](https://github.com/stella/stella/commit/b65402c1275643db5739fdfaab6156fe5e7524f5) Thanks [@jan-kubica](https://github.com/jan-kubica)! - The registry cache fingerprints tool schemas through `@stll/stable-stringify` instead of a private copy. Key order and output are unchanged, so cached deltas stay valid.

- [#2972](https://github.com/stella/stella/pull/2972) [`58951e1`](https://github.com/stella/stella/commit/58951e13fa4c181473e19b3ec2d35d19f3fa9bda) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Remove suppression directives for a retired lint rule; no runtime change.
- Updated dependencies [[`b65402c`](https://github.com/stella/stella/commit/b65402c1275643db5739fdfaab6156fe5e7524f5)]:
  - @stll/stable-stringify@0.2.0

## 0.10.0

### Minor Changes

- [#2839](https://github.com/stella/stella/pull/2839) [`27f0a67`](https://github.com/stella/stella/commit/27f0a67434fbbf1d66da2236f767eccd31fbf451) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Rename the workspace-scoping tool input to `workspace_id`. Breaking for the generated commands that scoped to a workspace: they now take `--workspace-id` instead of `--matter-id`, as does `stella upload`. Matter-entity commands (`matter save`, `matter delete`, `matter list`, `matter link-contact`) keep `--matter-id`. `--input` still accepts the deprecated `matter_id` key for one release.

## 0.9.0

### Minor Changes

- [#2759](https://github.com/stella/stella/pull/2759) [`700b43d`](https://github.com/stella/stella/commit/700b43d923d29a4c3025dc16ffbf2e390a08b82a) Thanks [@shanehobson](https://github.com/shanehobson)! - Expose the chat thread fork endpoint. `POST /chat/threads/:threadId/fork` copies
  a thread's history up to a chosen message into a new thread, so the route map
  and capability catalog now carry it.

### Patch Changes

- [#2799](https://github.com/stella/stella/pull/2799) [`9572668`](https://github.com/stella/stella/commit/95726685abcd668540f3b499aed9b5b31c133476) Thanks [@jan-kubica](https://github.com/jan-kubica)! - The generated agent skill (`stella-cli/SKILL.md`) now documents every curated
  command's flags (name, required/optional, type, one-line description) and adds
  a "When no curated command fits" section: the live capability domain list, two
  worked `stella capability <domain> <action>` examples, and a note that
  `--input` JSON keys follow the schema's own casing (snake_case for curated
  tools, camelCase for capability commands) rather than a guessable convention.
  It also states that the CLI cannot upload a binary file (a new document
  version), which needs an MCP-connected client or the web app instead.

- [#2831](https://github.com/stella/stella/pull/2831) [`1526d76`](https://github.com/stella/stella/commit/1526d7634ac8ff39ec8cdd7081ff2a39a403bedd) Thanks [@jan-kubica](https://github.com/jan-kubica)! - The capability catalog lists the task assignee move operation, which reassigns a task from one person to another in a single request.

- [#2801](https://github.com/stella/stella/pull/2801) [`440d293`](https://github.com/stella/stella/commit/440d293cf213ef78c9e19378dd9bda3deed7f7b8) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Regenerate template tool descriptions (`list_templates`, `fill_template`, `save_filled_template`) for the required-fields fill rejection and `arrays` shape hint.

## 0.8.0

### Minor Changes

- [#2771](https://github.com/stella/stella/pull/2771) [`4c0377f`](https://github.com/stella/stella/commit/4c0377f5ab2a3265ec4f80422118ee29b4ad72ce) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Login persists the default server; `--scopes` takes resource scopes only and the identity set (incl. `offline_access`) is always requested; `whoami` shows the account; `--server` is accepted by every command; the registry drift notice no longer fires for feature-gated tools and names the tools it does report. Removed the no-op `--keychain` flag, renamed `upload --workspace` to `--matter-id`, moved `search read` to `document content`, and `invoke_capability`'s `validateOnly` argument is now `validate_only` (the `--validate-only` flag is unchanged).

- [#2789](https://github.com/stella/stella/pull/2789) [`f584dc5`](https://github.com/stella/stella/commit/f584dc5248faf1e1592ed19dbadb965a585402ee) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Every tool input is snake_case at every depth. `clause save` body paragraphs take `list_kind`, `list_level`, `is_directive`, `directive_kind`, `directive_expression`; `template save` field overlays take `input_type`, `options_from`, `ai_prompt`, `ai_adapt`, `ai_sees_document`, `date_format`, `parts[].input_type` and `validation.min_length`/`max_length`/`min_items`/`max_items`; `organization set-jurisdictions` takes `country_code` and `is_primary`. The former camelCase spellings are rejected. `date-time` inputs admit a leap second only as `23:59:60`.

### Patch Changes

- [#2785](https://github.com/stella/stella/pull/2785) [`41fddf1`](https://github.com/stella/stella/commit/41fddf1ee88637d63b6d31857e2519da067643b2) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Generated capability commands expose bounded integer flags where the server advertises them instead of routing those fields to `--input`; `date` and `date-time` inputs are refused when they name a day the calendar lacks or a time field out of range.

## 0.7.2

### Patch Changes

- [#2681](https://github.com/stella/stella/pull/2681) [`55fbefc`](https://github.com/stella/stella/commit/55fbefcd2b202ac40d9222ac6c9fb4d3507fe96d) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Extend the capability catalog with the document review endpoints: proposing
  positions from a reference, resolving parties, and saving a run as a playbook.

## 0.7.1

### Patch Changes

- [#2669](https://github.com/stella/stella/pull/2669) [`faa424b`](https://github.com/stella/stella/commit/faa424b60009a5a05e431e09137a167518d20cdf) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Ship the capability catalog from one canonical package path.

## 0.7.0

### Minor Changes

- [#2350](https://github.com/stella/stella/pull/2350) [`e593a45`](https://github.com/stella/stella/commit/e593a45715d1fe07f27841de5539f548c8787ed2) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Refresh the capability catalog with the inbox signal capabilities (list, read, request, snooze, dismiss, assign, accept), retain the governed `my-work` queue for the Inbox work view, and drop the retired `my-tasks` capability. The navigation-only count endpoint remains internal.

### Patch Changes

- [#2613](https://github.com/stella/stella/pull/2613) [`4f8e6c8`](https://github.com/stella/stella/commit/4f8e6c847cf29b50f1e2a96defdb2068c6cf2476) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Refresh the `work-obligations.queues.list` capability description: the My Work queues now partition the owner's work (at-risk holds due work; inbox and upcoming split the rest by acknowledgement).

- [#2623](https://github.com/stella/stella/pull/2623) [`fb15c4d`](https://github.com/stella/stella/commit/fb15c4d1d4da13123c07abd64d69651dd99b9ae0) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Rename the `work-obligations.queues.list` queue value `inbox` to `to_acknowledge`, so the governed My Work queue no longer collides with the inbox signal feed. The capability description names the new queue.

- [#2618](https://github.com/stella/stella/pull/2618) [`f361688`](https://github.com/stella/stella/commit/f361688d3177ec025f399c9f4393590a7c9eb829) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Accept `court` as a work-obligation source type on `work-obligations.update`, for deadlines that come from a court registry rather than a calendar.

## 0.6.8

### Patch Changes

- [#2525](https://github.com/stella/stella/pull/2525) [`fe88df0`](https://github.com/stella/stella/commit/fe88df042170c2e1e3ed844fb044ba683240d6fe) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Regenerate the capability catalog with the bounded workflow target-count input.

- [#2526](https://github.com/stella/stella/pull/2526) [`355d6c1`](https://github.com/stella/stella/commit/355d6c1e48fef5d15f15435bd9ce26a0f88b4b2e) Thanks [@jan-kubica](https://github.com/jan-kubica)! - - @stll/auth-model: Require a verified email address before an organization invitation grants access.
  - @stll/cli: Regenerate the route map for the `properties.preview` capability's access and scope.
  - @stll/workspace-ui: Load person avatar images lazily and without a referrer.

- [#2517](https://github.com/stella/stella/pull/2517) [`787c653`](https://github.com/stella/stella/commit/787c65351474e007eb8ae99b950035ba29aaa9b3) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Expose skill revision, proposal, and comment capabilities.

## 0.6.7

### Patch Changes

- [#2474](https://github.com/stella/stella/pull/2474) [`8644102`](https://github.com/stella/stella/commit/86441029782024b5364b1adf011152cfed99a755) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Describe the Better Auth 1.7 issuer identity contract and request resource-scoped OAuth tokens from the CLI.

## 0.6.6

### Patch Changes

- [#2372](https://github.com/stella/stella/pull/2372) [`425b628`](https://github.com/stella/stella/commit/425b6285ee00f22cebcb5635f4433dcb1938d841) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Use canonical Valibot guards and discard unmodeled registry and OAuth response fields.

- [#2389](https://github.com/stella/stella/pull/2389) [`5c2aff5`](https://github.com/stella/stella/commit/5c2aff55fb6c454aadc1dbfbf97baac3cdd057c3) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Consolidate shared command execution contracts without changing CLI behavior.

- [#2379](https://github.com/stella/stella/pull/2379) [`d21b5dc`](https://github.com/stella/stella/commit/d21b5dca3bd92767a441ef8531cb5c52e2161589) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Keep legislation command metadata aligned with the public reader response.

## 0.6.5

### Patch Changes

- [#2328](https://github.com/stella/stella/pull/2328) [`cd0f66c`](https://github.com/stella/stella/commit/cd0f66c62f815f8e351829aaba63429e6127f2a0) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add the `entities bilingual-create` capability leaf: create a two-column bilingual copy of a DOCX document.

- [#2338](https://github.com/stella/stella/pull/2338) [`f9dc04a`](https://github.com/stella/stella/commit/f9dc04afa5045c757a57a31938554a32bde6f984) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add an optional `maxChildren` cap to the condition builder's capabilities; refresh the capability catalog with the bounded request filter arrays.

- [#2333](https://github.com/stella/stella/pull/2333) [`60a11f4`](https://github.com/stella/stella/commit/60a11f4d18e38870f02882ef41a6d39b925eb343) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add an optional `maxSorts` cap to `SortChips`; refresh the capability catalog with the separate view-sort bound and the raised property cap.

## 0.6.4

### Patch Changes

- [#2319](https://github.com/stella/stella/pull/2319) [`abc9956`](https://github.com/stella/stella/commit/abc9956c2500d573daac99eb0141ef852724d334) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Expose citation-resolution census counts in the case-law ingestion status.

## 0.6.3

### Patch Changes

- [#2275](https://github.com/stella/stella/pull/2275) [`07bc505`](https://github.com/stella/stella/commit/07bc50550c4368d7872ee3b4579e5be9b2dd3fb5) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add the bundled template-pack capabilities to the generated capability surface: list and read a pack, install its templates, and set whether the catalogue is offered.

## 0.6.2

### Patch Changes

- [#2101](https://github.com/stella/stella/pull/2101) [`440fc24`](https://github.com/stella/stella/commit/440fc24564fe59fbc38ad90bcb4e42ca6a24e50d) Thanks [@mirabatista](https://github.com/mirabatista)! - Refresh the generated capability catalog for the contact import endpoints.

- [#2101](https://github.com/stella/stella/pull/2101) [`440fc24`](https://github.com/stella/stella/commit/440fc24564fe59fbc38ad90bcb4e42ca6a24e50d) Thanks [@mirabatista](https://github.com/mirabatista)! - Describe contact directory exports in the generated capability catalog.

## 0.6.1

### Patch Changes

- [#2150](https://github.com/stella/stella/pull/2150) [`001496f`](https://github.com/stella/stella/commit/001496fdb43bee8301f50048e151187e011a9fed) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Accept an optional restated size estimate when starting a flow run through the generated capability surface.

## 0.6.0

### Minor Changes

- [#1939](https://github.com/stella/stella/pull/1939) [`772d79e`](https://github.com/stella/stella/commit/772d79e72739167c1b9deddb1d4a8214f8da2cae) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Describe each capability's file transport as a single disposition instead of two independent booleans. `list_capabilities` and `describe_capability` now carry a `transport` object naming the file field, whether it is required, the media types each leg accepts, and where the work can be done when the generic path cannot carry it; the `requiresFileInput` and `returnsFileResponse` fields are removed, with no compatibility aliases. A capability whose file input is optional now generates a command with the file field withheld, rather than being suppressed outright.

- [#1941](https://github.com/stella/stella/pull/1941) [`741fc94`](https://github.com/stella/stella/commit/741fc94b32ed60712f821c1b26964db65a1d2434) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Remove the synchronous `playbooks.review` capability. Document reviews now run as durable background runs; the review result is available through the document review run endpoints instead of a single blocking call.

### Patch Changes

- [#2014](https://github.com/stella/stella/pull/2014) [`1e00283`](https://github.com/stella/stella/commit/1e00283a0a6b2c82c9aa40a0bd73c4cee696f088) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Allow `playbooks.from-starter` to select the bundled SaaS agreement starter.

- [#1936](https://github.com/stella/stella/pull/1936) [`b5a39f0`](https://github.com/stella/stella/commit/b5a39f02b8da219af37e27f361b057ee68d8210e) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Ship every capability's full input schema. Three view capabilities previously exceeded the export byte cap and shipped with no schema at all, so `views.create`, `views.update` and `view-templates.create` had no typed flags and no local `--input` validation; schemas are now `$defs`-compacted instead of dropped, and the generated route map shrinks from 4.47 MB to 1.66 MB.

- [#2006](https://github.com/stella/stella/pull/2006) [`e8a7695`](https://github.com/stella/stella/commit/e8a76955b6b10e20fe42ff894f73851d2d3964a3) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Describe the remaining 237 capabilities, so every command the CLI generates now ships a `--help` brief written from its handler: what the operation does, the scope it acts in, when it skips or refuses, and the distinctions that separate it from its neighbours (list versus read-window, update versus upsert, the export formats' differing constraints).

- [#1930](https://github.com/stella/stella/pull/1930) [`b9441e7`](https://github.com/stella/stella/commit/b9441e796ccbabd1a371ca2d9b6ef793c9836546) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Describe the 31 destructive capabilities: what each one destroys, its scope, whether it can be undone, and when it skips or refuses. The prose reaches the generated command's `--help` brief and the shipped capability catalog.

- [#1920](https://github.com/stella/stella/pull/1920) [`fd9a1d1`](https://github.com/stella/stella/commit/fd9a1d19c1b809c2ab54b1158462ea1f5c7aec11) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Expose the document review endpoints (reference sources, topic proposal, reference comparison) in the generated capability catalog and route map.

- [#2058](https://github.com/stella/stella/pull/2058) [`d536ff4`](https://github.com/stella/stella/commit/d536ff41ac40f4cd75b52e1dd29fba88f97ddabc) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Expose bundled starter creation and recent Playbooks through the generated CLI capability surface.

- [#2043](https://github.com/stella/stella/pull/2043) [`df95bcf`](https://github.com/stella/stella/commit/df95bcf9b24b55a9b1f1002d75e08f6655a49117) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Describe document text processing with one implementation-neutral state in the generated MCP registry.

- [#1908](https://github.com/stella/stella/pull/1908) [`f7151cc`](https://github.com/stella/stella/commit/f7151cca6561a9687b4d985ee5e6980705ff71ef) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Carry the playbook concurrency tokens in the generated catalog and route map. `playbooks.approve` now requires `--expected-updated-at` (the `updatedAt` read with the definition) and refuses to snapshot a definition that changed since; `playbooks.update` accepts the same flag optionally and refuses a stale overwrite when it is given. Both commands return the definition's new `updatedAt` for the next call.

- [#1970](https://github.com/stella/stella/pull/1970) [`685369e`](https://github.com/stella/stella/commit/685369e49dec8b7f0779c8a6c61e61aa873bbf0c) Thanks [@jan-kubica](https://github.com/jan-kubica)! - The playbook run capability accepts a `projection` choice: materialize table columns as before, or record review findings only.

- [#1890](https://github.com/stella/stella/pull/1890) [`434b661`](https://github.com/stella/stella/commit/434b6610b1135f2a2c75d384982aa05c32ceae94) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Keep file-returning template capabilities describe-only in the generated CLI catalog.

## 0.5.0

### Minor Changes

- [#1149](https://github.com/stella/stella/pull/1149) [`9873ffb`](https://github.com/stella/stella/commit/9873ffb54fb18a874da90a456f0d7e84f3a761c6) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add first-class capability metadata and routes for agent sandbox runs.

- [#1200](https://github.com/stella/stella/pull/1200) [`7e53091`](https://github.com/stella/stella/commit/7e53091060df479830961d7be7948f2bdef739c2) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add legal-list capabilities to the CLI and expose nested entity-kind condition matching.

### Patch Changes

- [#746](https://github.com/stella/stella/pull/746) [`a325d07`](https://github.com/stella/stella/commit/a325d07276fa127a7296ed2dc3daeb53dd289fbb) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Expose AI memory capabilities in the generated command catalog.

- [#1782](https://github.com/stella/stella/pull/1782) [`891b685`](https://github.com/stella/stella/commit/891b6856715f07a91d1b7a7ef5251276c33ba795) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Negotiate API protocol revisions and capabilities instead of coupling compatibility to the CLI package version.

- [#1802](https://github.com/stella/stella/pull/1802) [`767b1f6`](https://github.com/stella/stella/commit/767b1f6ab46d42aad69c38a45a3a1be5d304ced6) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Hide deployment-disabled Legal Lists and governed workflow commands from the generated capability catalog.

- [#1535](https://github.com/stella/stella/pull/1535) [`e481b47`](https://github.com/stella/stella/commit/e481b477b9ea185d149a32c6cab7be0c2a557f0b) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Expose governed matter workflow commands through the CLI capability catalog.

- [#1834](https://github.com/stella/stella/pull/1834) [`e731ce9`](https://github.com/stella/stella/commit/e731ce9cdcf411e20508d2f8b08a0829a4dd7198) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Expose the time-entry summary capability in the generated CLI catalog.

- [#1839](https://github.com/stella/stella/pull/1839) [`3eaa322`](https://github.com/stella/stella/commit/3eaa322e8683cb04ba1d9252cbbad2626835060c) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Generate MCP paths, scopes, and error codes from the API-owned contract.

- [#1812](https://github.com/stella/stella/pull/1812) [`93304d8`](https://github.com/stella/stella/commit/93304d8a9e682336c1a30ef5bc4176d4d0323fc8) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Expose actionable document-processing states and retryable ARES failures through stella MCP clients.

- [#1833](https://github.com/stella/stella/pull/1833) [`6c52d14`](https://github.com/stella/stella/commit/6c52d14c82dfecc3a2d7317daa12f86aa9ddde62) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Include canonical resource names in case-law tool metadata.

- [#1847](https://github.com/stella/stella/pull/1847) [`6c68be3`](https://github.com/stella/stella/commit/6c68be3520868948fcd2426a89d6ce9d9e893fd4) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Refresh generated capability metadata.

## 0.4.3

### Patch Changes

- [#1777](https://github.com/stella/stella/pull/1777) [`55c409f`](https://github.com/stella/stella/commit/55c409f6c273e6e8cfdcfb2af4dd6e5ae5792df5) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Keep attached-file document uploads separate from the interactive MCP App picker.

## 0.4.2

### Patch Changes

- [#1765](https://github.com/stella/stella/pull/1765) [`3b33233`](https://github.com/stella/stella/commit/3b33233800a45b55258fa7b145d19befd4a8c91d) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add the one-command document version upload workflow and run CLI MCP traffic through the official v2 client transport.

## 0.4.1

### Patch Changes

- [#1741](https://github.com/stella/stella/pull/1741) [`0f1eceb`](https://github.com/stella/stella/commit/0f1eceb55bc199fb79d58680aec793cb755854e3) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Expose stella product identity through the generated MCP resource registry.

## 0.4.0

### Minor Changes

- [#1585](https://github.com/stella/stella/pull/1585) [`57ca112`](https://github.com/stella/stella/commit/57ca112b14f390e433cb1c59193c00ec4a0a4e5f) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Accept and project the `title` tool annotation from fetched registries (string, capped at 64 characters); the committed registry snapshot now carries display titles for every tool.

### Patch Changes

- [#1554](https://github.com/stella/stella/pull/1554) [`693f394`](https://github.com/stella/stella/commit/693f394d9ab8294947dc0f2f50432839ad297ae4) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Describe manual OCR requests as queued for the next configured batch.

- [#1565](https://github.com/stella/stella/pull/1565) [`d5647b6`](https://github.com/stella/stella/commit/d5647b62b14c5771402a28183b80c01557504262) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Update CLI typed error handling for better-result 3 compatibility.

- [#1537](https://github.com/stella/stella/pull/1537) [`6dbe458`](https://github.com/stella/stella/commit/6dbe4589b86d6f5af385f510d7b91d782b52974e) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Bound property dependency inputs to the workspace property limit.

## 0.3.1

### Patch Changes

- [#1428](https://github.com/stella/stella/pull/1428) [`d0826dc`](https://github.com/stella/stella/commit/d0826dc95e9031c1761d8d628fd42a06fa8528e9) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Expose the chat message export capability in the generated catalog.

- [#1373](https://github.com/stella/stella/pull/1373) [`34d0934`](https://github.com/stella/stella/commit/34d09345259793b0837c0fec55b0e47c075ec408) Thanks [@Pallavikumarimdb](https://github.com/Pallavikumarimdb)! - Expose the clause export format selector in the generated capability catalog.

- [#1464](https://github.com/stella/stella/pull/1464) [`2f3ccb4`](https://github.com/stella/stella/commit/2f3ccb4e6e72705a54d05503a4e33b80c0103d09) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Expose the organization document-processing mode in the generated capability catalog.

- [#1512](https://github.com/stella/stella/pull/1512) [`2cba1a6`](https://github.com/stella/stella/commit/2cba1a6ddcaacb1c464f4d90af1cd89f63d5fbc3) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Keep generated CLI version metadata synchronized during automated releases.

- [#1450](https://github.com/stella/stella/pull/1450) [`a5c2783`](https://github.com/stella/stella/commit/a5c27833a87a334b5258c1c8d2f682ed3d4d708d) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Expose repository skill discovery and import through the generated capability catalog.

- [#1501](https://github.com/stella/stella/pull/1501) [`9b91c0c`](https://github.com/stella/stella/commit/9b91c0cf0203a6c56219f3f8ff7f17527c9127ae) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add commands for saving a filled template as a new document or document version.

## 0.3.0

- Normalized capability action names and updated the CLI/API compatibility contract.
