# @stll/cli

## 2.0.2

### Patch Changes

- [#3873](https://github.com/stella/stella/pull/3873) [`0fc08ad`](https://github.com/stella/stella/commit/0fc08ad1ea1badd2e9c1f044acc0b3905436b2b7) Thanks [@jan-kubica](https://github.com/jan-kubica)! - `catalogue install` requires the skill-create permission instead of organization settings access, so a member can install a catalogue skill at private scope. Team scope still requires an owner or admin.

- [#3873](https://github.com/stella/stella/pull/3873) [`0fc08ad`](https://github.com/stella/stella/commit/0fc08ad1ea1badd2e9c1f044acc0b3905436b2b7) Thanks [@jan-kubica](https://github.com/jan-kubica)! - `skills seed` is gone: a member's default skills are installed when the membership is created.

- [#3888](https://github.com/stella/stella/pull/3888) [`718d19d`](https://github.com/stella/stella/commit/718d19d57206fea56a6ae6773e3b2221bb7bf084) Thanks [@jan-kubica](https://github.com/jan-kubica)! - The legislation read help states that full text is returned only when the parsed structure is missing or unusable.

## 2.0.1

### Patch Changes

- [#3779](https://github.com/stella/stella/pull/3779) [`93707c1`](https://github.com/stella/stella/commit/93707c1ad9ae2b3695ce1a3b757aa586cb2f3730) Thanks [@jan-kubica](https://github.com/jan-kubica)! - New list capabilities: `lists.verifications.list` lists a document's verifications, newest first, with claim counts per verdict state; `lists.verifications.latest.list` reads the latest verification of up to 200 document files at once.

- [#3776](https://github.com/stella/stella/pull/3776) [`54fcb49`](https://github.com/stella/stella/commit/54fcb49c85b75b9ce9735e10870a982aee53094d) Thanks [@jan-kubica](https://github.com/jan-kubica)! - New list capabilities: `lists.items.fact-details.update` sets a fact item's date, evidence kind, medium, confidence, interpretation note and scoring hold; `lists.verifications.create` starts checking a document against a list's facts; `lists.verifications.get` reads the claims found and their verdicts; `lists.verifications.claim-reviews.create` and `lists.verifications.claim-reviews.bulk.create` record reviewer decisions on those claims.

- [#3855](https://github.com/stella/stella/pull/3855) [`87d7e83`](https://github.com/stella/stella/commit/87d7e83e147338c5450be4e3db0904873c862d16) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Narrow values with type guards instead of type assertions, and give internal CLI helpers names that describe what they hold. `mapEntityStatus` now reads only the codes its mapping declares, so an inherited object key maps to `unknown`.

## 2.0.0

### Major Changes

- [#3761](https://github.com/stella/stella/pull/3761) [`13cf646`](https://github.com/stella/stella/commit/13cf6467659197b7bdf5827c68bf0571338cab58) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Capability ids name nested resources: `<domain>[.<resource>…].<action>`, where the action is `list`, `get`, `create`, `update`, `delete`, or a single-word domain verb. Compound actions moved into the resource path, so the `invoke_capability` ids below changed, and so did each generated command whose flattened name changed. The previous ids are not accepted; an unknown id's error suggests the closest current ids.

  | Previous id                                            | Id                                                     | Command (previous → current)                                                                                                                        |
  | ------------------------------------------------------ | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `case-law.ingestion.status`                            | `case-law.ingestion.get`                               | `stella capability case-law ingestion-status` → `stella capability case-law ingestion-get`                                                          |
  | `catalogue.install-skill`                              | `catalogue.install`                                    | `stella capability catalogue install-skill` → `stella capability catalogue install`                                                                 |
  | `catalogue.list-catalogue`                             | `catalogue.list`                                       | `stella capability catalogue list-catalogue` → `stella capability catalogue list`                                                                   |
  | `chat.delete-thread`                                   | `chat.threads.delete`                                  | `stella capability chat delete-thread` → `stella capability chat threads-delete`                                                                    |
  | `chat.get-messages`                                    | `chat.messages.list`                                   | `stella capability chat get-messages` → `stella capability chat messages-list`                                                                      |
  | `chat.get-older-messages`                              | `chat.older-messages.list`                             | `stella capability chat get-older-messages` → `stella capability chat older-messages-list`                                                          |
  | `chat.get-threads`                                     | `chat.threads.list`                                    | `stella capability chat get-threads` → `stella capability chat threads-list`                                                                        |
  | `chat.rename-thread`                                   | `chat.threads.rename`                                  | `stella capability chat rename-thread` → `stella capability chat threads-rename`                                                                    |
  | `chat.update-thread`                                   | `chat.threads.update`                                  | `stella capability chat update-thread` → `stella capability chat threads-update`                                                                    |
  | `clauses.categories-create`                            | `clauses.categories.create`                            | unchanged                                                                                                                                           |
  | `clauses.categories-delete`                            | `clauses.categories.delete`                            | unchanged                                                                                                                                           |
  | `clauses.categories-list`                              | `clauses.categories.list`                              | unchanged                                                                                                                                           |
  | `clauses.categories-update`                            | `clauses.categories.update`                            | unchanged                                                                                                                                           |
  | `clauses.read-version`                                 | `clauses.versions.get`                                 | `stella capability clauses read-version` → `stella capability clauses versions-get`                                                                 |
  | `clauses.template-slot-preview`                        | `clauses.template-slots.preview`                       | `stella capability clauses template-slot-preview` → `stella capability clauses template-slots-preview`                                              |
  | `clauses.variants-create`                              | `clauses.variants.create`                              | unchanged                                                                                                                                           |
  | `clauses.variants-delete`                              | `clauses.variants.delete`                              | unchanged                                                                                                                                           |
  | `clauses.variants-list`                                | `clauses.variants.list`                                | unchanged                                                                                                                                           |
  | `clauses.variants-update`                              | `clauses.variants.update`                              | unchanged                                                                                                                                           |
  | `clauses.versions-diff`                                | `clauses.versions.diff`                                | unchanged                                                                                                                                           |
  | `clauses.versions-restore`                             | `clauses.versions.restore`                             | unchanged                                                                                                                                           |
  | `clauses.versions-summarize`                           | `clauses.versions.summarize`                           | unchanged                                                                                                                                           |
  | `contacts.business-registries-lookup`                  | `contacts.business-registries.lookup`                  | unchanged                                                                                                                                           |
  | `entities.check-stamp`                                 | `entities.stamps.check`                                | `stella capability entities check-stamp` → `stella capability entities stamps-check`                                                                |
  | `entities.copy-to-matter`                              | `entities.copy`                                        | `stella capability entities copy-to-matter` → `stella capability entities copy`                                                                     |
  | `entities.create-blank-document`                       | `entities.blank-document.create`                       | `stella capability entities create-blank-document` → `stella capability entities blank-document-create`                                             |
  | `entities.create-from-legal-source`                    | `entities.from-legal-source.create`                    | `stella capability entities create-from-legal-source` → `stella capability entities from-legal-source-create`                                       |
  | `entities.delete-version`                              | `entities.versions.delete`                             | `stella capability entities delete-version` → `stella capability entities versions-delete`                                                          |
  | `entities.download-zip`                                | `entities.zip.download`                                | `stella capability entities download-zip` → `stella capability entities zip-download`                                                               |
  | `entities.list-files`                                  | `entities.files.list`                                  | `stella capability entities list-files` → `stella capability entities files-list`                                                                   |
  | `entities.list-folders`                                | `entities.folders.list`                                | `stella capability entities list-folders` → `stella capability entities folders-list`                                                               |
  | `entities.organize-suggestions`                        | `entities.placements.suggest`                          | `stella capability entities organize-suggestions` → `stella capability entities placements-suggest`                                                 |
  | `entities.read-filesystem-tree`                        | `entities.filesystem-tree.get`                         | `stella capability entities read-filesystem-tree` → `stella capability entities filesystem-tree-get`                                                |
  | `entities.read-summaries`                              | `entities.summaries.list`                              | `stella capability entities read-summaries` → `stella capability entities summaries-list`                                                           |
  | `entities.read-summaries-count`                        | `entities.summaries.count`                             | `stella capability entities read-summaries-count` → `stella capability entities summaries-count`                                                    |
  | `entities.read-version-by-id`                          | `entities.versions.get`                                | `stella capability entities read-version-by-id` → `stella capability entities versions-get`                                                         |
  | `entities.read-versions`                               | `entities.versions.list`                               | `stella capability entities read-versions` → `stella capability entities versions-list`                                                             |
  | `entities.read-window`                                 | `entities.window.list`                                 | `stella capability entities read-window` → `stella capability entities window-list`                                                                 |
  | `entities.restore-version`                             | `entities.versions.restore`                            | `stella capability entities restore-version` → `stella capability entities versions-restore`                                                        |
  | `entities.update-version-description`                  | `entities.versions.description.update`                 | `stella capability entities update-version-description` → `stella capability entities versions-description-update`                                  |
  | `entities.update-version-label`                        | `entities.versions.label.update`                       | `stella capability entities update-version-label` → `stella capability entities versions-label-update`                                              |
  | `entities.upload-version`                              | `entities.versions.upload`                             | `stella capability entities upload-version` → `stella capability entities versions-upload`                                                          |
  | `entities.version-diff`                                | `entities.versions.diff`                               | `stella capability entities version-diff` → `stella capability entities versions-diff`                                                              |
  | `entities.version-summarize`                           | `entities.versions.summarize`                          | `stella capability entities version-summarize` → `stella capability entities versions-summarize`                                                    |
  | `fields.mark-column-flag`                              | `fields.column-flag.update`                            | `stella capability fields mark-column-flag` → `stella capability fields column-flag-update`                                                         |
  | `fields.update-cell-metadata`                          | `fields.cell-metadata.update`                          | `stella capability fields update-cell-metadata` → `stella capability fields cell-metadata-update`                                                   |
  | `fields.upsert-by-id`                                  | `fields.upsert`                                        | `stella capability fields upsert-by-id` → `stella capability fields upsert`                                                                         |
  | `flows.run-cancel`                                     | `flows.runs.cancel`                                    | `stella capability flows run-cancel` → `stella capability flows runs-cancel`                                                                        |
  | `flows.run-detail`                                     | `flows.runs.get`                                       | `stella capability flows run-detail` → `stella capability flows runs-get`                                                                           |
  | `flows.run-list`                                       | `flows.runs.list`                                      | `stella capability flows run-list` → `stella capability flows runs-list`                                                                            |
  | `flows.run-review`                                     | `flows.runs.review`                                    | `stella capability flows run-review` → `stella capability flows runs-review`                                                                        |
  | `flows.run-start`                                      | `flows.runs.start`                                     | `stella capability flows run-start` → `stella capability flows runs-start`                                                                          |
  | `invoices.add-entries`                                 | `invoices.entries.add`                                 | `stella capability invoices add-entries` → `stella capability invoices entries-add`                                                                 |
  | `invoices.remove-entries`                              | `invoices.entries.remove`                              | `stella capability invoices remove-entries` → `stella capability invoices entries-remove`                                                           |
  | `legislation.boe-get-law`                              | `legislation.boe.laws.get`                             | `stella capability legislation boe-get-law` → `stella capability legislation boe-laws-get`                                                          |
  | `legislation.boe-law-structure`                        | `legislation.boe.law-structure.get`                    | `stella capability legislation boe-law-structure` → `stella capability legislation boe-law-structure-get`                                           |
  | `legislation.boe-related-laws`                         | `legislation.boe.related-laws.list`                    | `stella capability legislation boe-related-laws` → `stella capability legislation boe-related-laws-list`                                            |
  | `legislation.boe-search`                               | `legislation.boe.search`                               | unchanged                                                                                                                                           |
  | `legislation.boe-text-block`                           | `legislation.boe.text-block.get`                       | `stella capability legislation boe-text-block` → `stella capability legislation boe-text-block-get`                                                 |
  | `legislation.borme-summary`                            | `legislation.borme.summary.get`                        | `stella capability legislation borme-summary` → `stella capability legislation borme-summary-get`                                                   |
  | `matters.cell-retry`                                   | `matters.cells.retry`                                  | `stella capability matters cell-retry` → `stella capability matters cells-retry`                                                                    |
  | `matters.matter-contacts-create`                       | `matters.contacts.create`                              | `stella capability matters matter-contacts-create` → `stella capability matters contacts-create`                                                    |
  | `matters.matter-contacts-delete`                       | `matters.contacts.delete`                              | `stella capability matters matter-contacts-delete` → `stella capability matters contacts-delete`                                                    |
  | `matters.matter-members-add`                           | `matters.members.add`                                  | `stella capability matters matter-members-add` → `stella capability matters members-add`                                                            |
  | `matters.matter-members-remove`                        | `matters.members.remove`                               | `stella capability matters matter-members-remove` → `stella capability matters members-remove`                                                      |
  | `matters.read-justifications`                          | `matters.justifications.list`                          | `stella capability matters read-justifications` → `stella capability matters justifications-list`                                                   |
  | `matters.read-workflow-status`                         | `matters.workflow.get`                                 | `stella capability matters read-workflow-status` → `stella capability matters workflow-get`                                                         |
  | `matters.read-workflow-target-count`                   | `matters.workflow.targets.count`                       | `stella capability matters read-workflow-target-count` → `stella capability matters workflow-targets-count`                                         |
  | `matters.workflow-start`                               | `matters.workflow.start`                               | unchanged                                                                                                                                           |
  | `organization-settings.read-ai-availability`           | `organization-settings.ai-availability.get`            | `stella capability organization-settings read-ai-availability` → `stella capability organization-settings ai-availability-get`                      |
  | `organization-settings.read-anonymization-blacklist`   | `organization-settings.anonymization-blacklist.get`    | `stella capability organization-settings read-anonymization-blacklist` → `stella capability organization-settings anonymization-blacklist-get`      |
  | `organization-settings.read-deepl-availability`        | `organization-settings.deepl-availability.get`         | `stella capability organization-settings read-deepl-availability` → `stella capability organization-settings deepl-availability-get`                |
  | `organization-settings.update-anonymization-blacklist` | `organization-settings.anonymization-blacklist.update` | `stella capability organization-settings update-anonymization-blacklist` → `stella capability organization-settings anonymization-blacklist-update` |
  | `organization-settings.update-practice-jurisdictions`  | `organization-settings.practice-jurisdictions.update`  | `stella capability organization-settings update-practice-jurisdictions` → `stella capability organization-settings practice-jurisdictions-update`   |
  | `playbooks.auto-run`                                   | `playbooks.applicable.run`                             | `stella capability playbooks auto-run` → `stella capability playbooks applicable-run`                                                               |
  | `playbooks.from-run`                                   | `playbooks.from-run.create`                            | `stella capability playbooks from-run` → `stella capability playbooks from-run-create`                                                              |
  | `playbooks.from-starter`                               | `playbooks.from-starter.create`                        | `stella capability playbooks from-starter` → `stella capability playbooks from-starter-create`                                                      |
  | `playbooks.list-starters`                              | `playbooks.starters.list`                              | `stella capability playbooks list-starters` → `stella capability playbooks starters-list`                                                           |
  | `playbooks.list-versions`                              | `playbooks.versions.list`                              | `stella capability playbooks list-versions` → `stella capability playbooks versions-list`                                                           |
  | `playbooks.restore-version`                            | `playbooks.versions.restore`                           | `stella capability playbooks restore-version` → `stella capability playbooks versions-restore`                                                      |
  | `properties.create-batch`                              | `properties.batch.create`                              | `stella capability properties create-batch` → `stella capability properties batch-create`                                                           |
  | `properties.suggest-prompt`                            | `properties.prompt.suggest`                            | `stella capability properties suggest-prompt` → `stella capability properties prompt-suggest`                                                       |
  | `rates.entries-create`                                 | `rates.entries.create`                                 | unchanged                                                                                                                                           |
  | `rates.entries-delete`                                 | `rates.entries.delete`                                 | unchanged                                                                                                                                           |
  | `rates.entries-read`                                   | `rates.entries.list`                                   | `stella capability rates entries-read` → `stella capability rates entries-list`                                                                     |
  | `rates.entries-update`                                 | `rates.entries.update`                                 | unchanged                                                                                                                                           |
  | `reports.clone-builtin`                                | `reports.builtins.clone`                               | `stella capability reports clone-builtin` → `stella capability reports builtins-clone`                                                              |
  | `reports.export-view`                                  | `reports.views.export`                                 | `stella capability reports export-view` → `stella capability reports views-export`                                                                  |
  | `reports.list-exports`                                 | `reports.exports.list`                                 | `stella capability reports list-exports` → `stella capability reports exports-list`                                                                 |
  | `reports.list-templates`                               | `reports.templates.list`                               | `stella capability reports list-templates` → `stella capability reports templates-list`                                                             |
  | `reports.read-export`                                  | `reports.exports.get`                                  | `stella capability reports read-export` → `stella capability reports exports-get`                                                                   |
  | `skills.from-blueprint`                                | `skills.from-blueprint.create`                         | `stella capability skills from-blueprint` → `stella capability skills from-blueprint-create`                                                        |
  | `skills.generate-draft`                                | `skills.drafts.generate`                               | `stella capability skills generate-draft` → `stella capability skills drafts-generate`                                                              |
  | `skills.import-url`                                    | `skills.from-url.import`                               | `stella capability skills import-url` → `stella capability skills from-url-import`                                                                  |
  | `skills.list-commands`                                 | `skills.commands.list`                                 | `stella capability skills list-commands` → `stella capability skills commands-list`                                                                 |
  | `style-sets.create-from-editor`                        | `style-sets.from-editor.create`                        | `stella capability style-sets create-from-editor` → `stella capability style-sets from-editor-create`                                               |
  | `style-sets.read-editor`                               | `style-sets.editor.get`                                | `stella capability style-sets read-editor` → `stella capability style-sets editor-get`                                                              |
  | `style-sets.read-stella-editor`                        | `style-sets.stella-editor.get`                         | `stella capability style-sets read-stella-editor` → `stella capability style-sets stella-editor-get`                                                |
  | `style-sets.update-from-editor`                        | `style-sets.from-editor.update`                        | `stella capability style-sets update-from-editor` → `stella capability style-sets from-editor-update`                                               |
  | `tasks.assignees-add`                                  | `tasks.assignees.add`                                  | unchanged                                                                                                                                           |
  | `tasks.assignees-remove`                               | `tasks.assignees.remove`                               | unchanged                                                                                                                                           |
  | `tasks.calendar`                                       | `tasks.calendar.list`                                  | `stella capability tasks calendar` → `stella capability tasks calendar-list`                                                                        |
  | `tasks.entity-links-create`                            | `tasks.entity-links.create`                            | unchanged                                                                                                                                           |
  | `tasks.entity-links-delete`                            | `tasks.entity-links.delete`                            | unchanged                                                                                                                                           |
  | `tasks.entity-links-read`                              | `tasks.entity-links.list`                              | `stella capability tasks entity-links-read` → `stella capability tasks entity-links-list`                                                           |
  | `templates.binding-catalog`                            | `templates.bindings.list`                              | `stella capability templates binding-catalog` → `stella capability templates bindings-list`                                                         |
  | `templates.categories-create`                          | `templates.categories.create`                          | unchanged                                                                                                                                           |
  | `templates.categories-delete`                          | `templates.categories.delete`                          | unchanged                                                                                                                                           |
  | `templates.categories-list`                            | `templates.categories.list`                            | unchanged                                                                                                                                           |
  | `templates.categories-update`                          | `templates.categories.update`                          | unchanged                                                                                                                                           |
  | `templates.clause-slots`                               | `templates.clause-slots.list`                          | `stella capability templates clause-slots` → `stella capability templates clause-slots-list`                                                        |
  | `templates.clauses-link`                               | `templates.clauses.link`                               | unchanged                                                                                                                                           |
  | `templates.clauses-list`                               | `templates.clauses.list`                               | unchanged                                                                                                                                           |
  | `templates.clauses-slot-update`                        | `templates.clause-slots.update`                        | `stella capability templates clauses-slot-update` → `stella capability templates clause-slots-update`                                               |
  | `templates.clauses-sync`                               | `templates.clauses.sync`                               | unchanged                                                                                                                                           |
  | `templates.clauses-sync-all`                           | `templates.outdated-clauses.sync`                      | `stella capability templates clauses-sync-all` → `stella capability templates outdated-clauses-sync`                                                |
  | `templates.clauses-unlink`                             | `templates.clauses.unlink`                             | unchanged                                                                                                                                           |
  | `templates.create-blank`                               | `templates.blank.create`                               | `stella capability templates create-blank` → `stella capability templates blank-create`                                                             |
  | `templates.create-from-style-set`                      | `templates.from-style-set.create`                      | `stella capability templates create-from-style-set` → `stella capability templates from-style-set-create`                                           |
  | `templates.create-from-styles`                         | `templates.from-styles.create`                         | `stella capability templates create-from-styles` → `stella capability templates from-styles-create`                                                 |
  | `templates.fill-by-id`                                 | `templates.fills.download`                             | `stella capability templates fill-by-id` → `stella capability templates fills-download`                                                             |
  | `templates.fill-preview`                               | `templates.fills.preview`                              | `stella capability templates fill-preview` → `stella capability templates fills-preview`                                                            |
  | `templates.fill-to-matter`                             | `templates.fills.create`                               | `stella capability templates fill-to-matter` → `stella capability templates fills-create`                                                           |
  | `templates.lookup-preview`                             | `templates.lookups.preview`                            | `stella capability templates lookup-preview` → `stella capability templates lookups-preview`                                                        |
  | `templates.save-document`                              | `templates.document.update`                            | `stella capability templates save-document` → `stella capability templates document-update`                                                         |
  | `templates.suggest-fields`                             | `templates.fields.suggest`                             | `stella capability templates suggest-fields` → `stella capability templates fields-suggest`                                                         |
  | `templates.versions-diff`                              | `templates.versions.diff`                              | unchanged                                                                                                                                           |
  | `templates.versions-get`                               | `templates.versions.get`                               | unchanged                                                                                                                                           |
  | `templates.versions-list`                              | `templates.versions.list`                              | unchanged                                                                                                                                           |
  | `templates.versions-summarize`                         | `templates.versions.summarize`                         | unchanged                                                                                                                                           |
  | `time-entries.batch-delete`                            | `time-entries.batch.delete`                            | unchanged                                                                                                                                           |
  | `time-entries.batch-update`                            | `time-entries.batch.update`                            | unchanged                                                                                                                                           |
  | `time-entries.export-csv`                              | `time-entries.csv.export`                              | `stella capability time-entries export-csv` → `stella capability time-entries csv-export`                                                           |
  | `time-entries.export-ledes`                            | `time-entries.ledes.export`                            | `stella capability time-entries export-ledes` → `stella capability time-entries ledes-export`                                                       |
  | `time-entries.export-pdf`                              | `time-entries.pdf.export`                              | `stella capability time-entries export-pdf` → `stella capability time-entries pdf-export`                                                           |
  | `time-entries.timer-start`                             | `time-entries.timer.start`                             | unchanged                                                                                                                                           |
  | `time-entries.timer-stop`                              | `time-entries.timer.stop`                              | unchanged                                                                                                                                           |
  | `usage.get-entitlement`                                | `usage.entitlement.get`                                | `stella capability usage get-entitlement` → `stella capability usage entitlement-get`                                                               |
  | `views.table-export`                                   | `views.table.export`                                   | unchanged                                                                                                                                           |

### Minor Changes

- [#3735](https://github.com/stella/stella/pull/3735) [`56b68d7`](https://github.com/stella/stella/commit/56b68d77ba55974c5e485318c9e39bd097ce22cf) Thanks [@jan-kubica](https://github.com/jan-kubica)! - `annotation list|create|update|delete` reads and writes highlights and comments on case-law decisions and statute versions.

### Patch Changes

- [#3741](https://github.com/stella/stella/pull/3741) [`dbc1f5d`](https://github.com/stella/stella/commit/dbc1f5d6605e00a560aa977a3d9231bc5f7a8980) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Capabilities that create or change documents now require `stella:documents_write`, the consent the named document tools already required: `entities.upload`, `entities.versions.upload`, `entities.bilingual.create`, `entities.from-legal-source.create`, `entities.versions.restore`, `document-translations.runs.create`, and `fields.kanban-placement.update`. `entities.duplicate` and `entities.copy` require it in addition to `stella:matters_write`. Document uploads through `uploads.create` and `uploads.update` require it too, and `stella upload` checks for both scopes before starting a new document.

- [#3740](https://github.com/stella/stella/pull/3740) [`6c8ed73`](https://github.com/stella/stella/commit/6c8ed73fbffce3ee6768d35c3a5f112b94a9875c) Thanks [@jan-kubica](https://github.com/jan-kubica)! - `stella feedback submit` takes the `approval_token` that `stella feedback prepare` returns; the server refuses a report the token does not cover. Key-value output no longer truncates values without whitespace (tokens, ids, URLs), so they can be copied at any terminal width.

- [#3754](https://github.com/stella/stella/pull/3754) [`6b7dcc2`](https://github.com/stella/stella/commit/6b7dcc2aa330b863c8638497f5e463aa776480f4) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Template and capability commands advertise the input bounds and defaults the server already enforced. `DestructiveConfirmDialog` reports an unexpected confirm rejection instead of dropping it.

## 1.19.3

### Patch Changes

- [#3728](https://github.com/stella/stella/pull/3728) [`0d6bd5a`](https://github.com/stella/stella/commit/0d6bd5abf19cf86f71a6dd71ad9c39b3435fd8f1) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Narrow optional values before they reach rendered text and messages. The outline rail no longer draws a tick for a heading whose id matches an object prototype key.
- Updated dependencies [[`0d6bd5a`](https://github.com/stella/stella/commit/0d6bd5abf19cf86f71a6dd71ad9c39b3435fd8f1)]:
  - @stll/stable-stringify@0.2.1

## 1.19.2

### Patch Changes

- [#3694](https://github.com/stella/stella/pull/3694) [`036952a`](https://github.com/stella/stella/commit/036952a1bc97d05abefd2976b53c0647485c04f8) Thanks [@jan-kubica](https://github.com/jan-kubica)! - A citation's polarity can now read `mixed`, for a citing decision that departs from the cited one at one mention and relies on it at another.

## 1.19.1

### Patch Changes

- [#3675](https://github.com/stella/stella/pull/3675) [`92193be`](https://github.com/stella/stella/commit/92193bea3ea839677b85ec5a8ade314a6d50aea9) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Capability inputs for list reads, view-template deletion and desktop-edit handoff status now declare matterId.

## 1.19.0

### Minor Changes

- [#3615](https://github.com/stella/stella/pull/3615) [`3d707ee`](https://github.com/stella/stella/commit/3d707ee62711467446bca97c01610f7ad186f4c4) Thanks [@jan-kubica](https://github.com/jan-kubica)! - `stella feedback prepare` now takes a structured report (`--kind`, `--area`, `--title`, `--what-happened`, optional `--expected`, `--steps`, `--evidence`, and `--context.*`) and returns the sanitized report without sending anything. The new `stella feedback submit` files the approved report with the maintainers and prints a receipt (`FB-XXXX-XXXX`); it asks for confirmation, and `--yes` skips the prompt. The prefilled issue URL and `gh` command are gone.

## 1.18.1

### Patch Changes

- [#3648](https://github.com/stella/stella/pull/3648) [`d26c4dc`](https://github.com/stella/stella/commit/d26c4dc8850b2803b10a0f0917011513dd027093) Thanks [@jan-kubica](https://github.com/jan-kubica)! - A nested object flag such as `--base.url` is documented and checked as required when the tool requires it; `--input` still satisfies it.

## 1.18.0

### Minor Changes

- [#3642](https://github.com/stella/stella/pull/3642) [`7a4eb64`](https://github.com/stella/stella/commit/7a4eb647bd86097052c962031d4541bb65128272) Thanks [@jan-kubica](https://github.com/jan-kubica)! - `document comparison prepare-from-links` stages two .docx files for `document compare` from HTTPS links the server downloads.

## 1.17.0

### Minor Changes

- [#3621](https://github.com/stella/stella/pull/3621) [`4a0b87f`](https://github.com/stella/stella/commit/4a0b87fe1b7fb248273abac0ca7d586267f45009) Thanks [@jan-kubica](https://github.com/jan-kubica)! - `document compare` creates a tracked-changes DOCX redline between stored versions of a document, either against an explicit base or against a version's predecessor, previewing it or saving it as a derived version.

- [#3621](https://github.com/stella/stella/pull/3621) [`4a0b87f`](https://github.com/stella/stella/commit/4a0b87fe1b7fb248273abac0ca7d586267f45009) Thanks [@jan-kubica](https://github.com/jan-kubica)! - `document comparison prepare` reserves short-lived upload slots for two .docx files that are not stored in stella, and `document compare` gains an `uploads` source that redlines them and returns the result as a temporary download link.

## 1.16.0

### Minor Changes

- [#3614](https://github.com/stella/stella/pull/3614) [`67a71a6`](https://github.com/stella/stella/commit/67a71a6b38e4a077012736da52ea45b84f1f4548) Thanks [@shanehobson](https://github.com/shanehobson)! - The new `playbook save` creates a review playbook, or adds, changes, and removes positions in one: `positions` lists only what a call adds or changes (an entry with `source_id` replaces that stored position, one without is added), `remove_source_ids` deletes, and an update passes the playbook's `updatedAt` as `expected_updated_at`. `playbooks create` and `playbooks update` are now reached through it.

## 1.15.0

### Minor Changes

- [#3557](https://github.com/stella/stella/pull/3557) [`df130cb`](https://github.com/stella/stella/commit/df130cb9baa7c4f0c6986fc20861c2fedb657263) Thanks [@jan-kubica](https://github.com/jan-kubica)! - `stella capability entity-views rows-list` accepts `inboxView` in its input to return the caller's Inbox signals for that view in the same window as tasks, ordered by the same sorts under one cursor, and `--as-of` for the calendar day task risk is measured against.

## 1.14.0

### Minor Changes

- [#3572](https://github.com/stella/stella/pull/3572) [`0c68aa8`](https://github.com/stella/stella/commit/0c68aa803e92647e9ed87c462bac4708deeb9f15) Thanks [@jan-kubica](https://github.com/jan-kubica)! - `template fill` reports what each AI-decided condition was settled on and by whom; `template list --template-id` lists every `{% if %}` block with its governing field path and kind; the new `template preview-conditions` asks what a set of values would decide, at decision-model cost only.

### Patch Changes

- [#3591](https://github.com/stella/stella/pull/3591) [`02a482b`](https://github.com/stella/stella/commit/02a482b7f49a84d2e610a81b78aee70b244afd08) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Regenerate the MCP registry snapshot: `search_boe_legislation` no longer declares a five-character ceiling on `cursor`; the server reads a value no page boundary could be as no cursor.

## 1.13.0

### Minor Changes

- [#3571](https://github.com/stella/stella/pull/3571) [`0785172`](https://github.com/stella/stella/commit/0785172db16d55602f4ddf19e48a47269949080d) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Quieter registry drift and two ways to hand a command its input. A diverged
  server registry now prints one counted line on stderr, with the tool names
  behind `--verbose`, and stays silent for `--help`, `auth` and `compatibility`;
  when the drift removed the tool behind the command being run, that is an error
  on the command (exit 4) rather than an unknown-command usage failure. A command
  whose tool takes a document accepts `--file <path>`, reading the local file into
  the tool's own base64 field up to the ceiling that field's schema declares. Every
  generated command accepts `--schema`, printing its input JSON schema and exiting.

## 1.12.0

### Minor Changes

- [#3564](https://github.com/stella/stella/pull/3564) [`9f4aa8f`](https://github.com/stella/stella/commit/9f4aa8f4809e79da0ab7192f59d87238c8e495ae) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Adds `stella capability time-entries suggestions-list` and `stella capability time-entries suggestions-decisions-create`: list suggested time entries for a day from the signed-in user's own matter activity, then accept one into a time entry or dismiss it.

## 1.11.0

### Minor Changes

- [#3554](https://github.com/stella/stella/pull/3554) [`2d013c9`](https://github.com/stella/stella/commit/2d013c931f26a85b8c92c7300409670fd4d721f0) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Removes `stella capability tasks list`; `stella task list` lists tasks across matters.

## 1.10.0

### Minor Changes

- [#3550](https://github.com/stella/stella/pull/3550) [`aef1774`](https://github.com/stella/stella/commit/aef17746472f24758c790905ed26676c19b56770) Thanks [@jan-kubica](https://github.com/jan-kubica)! - `stella task list` no longer requires `--matter-id`: without it, it lists tasks across every matter you can read, soonest due first, and each task names its matter. `--assignee me` keeps only your own assignments. Adds the `stella capability tasks list` command for the same list over HTTP.

## 1.9.0

### Minor Changes

- [#3549](https://github.com/stella/stella/pull/3549) [`525a7b8`](https://github.com/stella/stella/commit/525a7b857df870ec1ff38fba706cf5addd8fd42f) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Mark commands the connected server has gated off everywhere they are listed: root `--help` and group briefs name disabled groups and children, and capability commands are marked from the server's new `x-stella-feature-omitted-capabilities` evidence in `--help` and `tools list`.

## 1.8.1

### Patch Changes

- [#3532](https://github.com/stella/stella/pull/3532) [`e0964ce`](https://github.com/stella/stella/commit/e0964cef872b0f20d62b8759af08e371ae88a55c) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Regenerate the MCP registry snapshot: the OpenAI-compatible `search` and `fetch` now state their result-id vocabulary, and `fetch` accepts a prefixed corpus id beside a document UUID. Both stay excluded from the CLI, which has its own corpus commands.

## 1.8.0

### Minor Changes

- [#3499](https://github.com/stella/stella/pull/3499) [`fec5b75`](https://github.com/stella/stella/commit/fec5b75de0cc1bbd4b922962f9deedcc16eb0205) Thanks [@jan-kubica](https://github.com/jan-kubica)! - `case-law search` no longer requires a question's function words. It reports
  `searches[].queryUsed` (the words the search required) and
  `searches[].warnings`, and takes `--strict` to require every word.

## 1.7.1

### Patch Changes

- [#3493](https://github.com/stella/stella/pull/3493) [`264593e`](https://github.com/stella/stella/commit/264593e2729be0a11aff8a206ad38451fdb56377) Thanks [@jan-kubica](https://github.com/jan-kubica)! - `--country` on `case-law search` and `legislation search` states what it
  accepts: an ISO 3166-1 alpha-3 or alpha-2 code, or the country's name in a
  language the corpus serves. The admitted list is unchanged; only the help text
  and the generated contract now describe the spellings the server reads.

## 1.7.0

### Minor Changes

- [#3470](https://github.com/stella/stella/pull/3470) [`53e54bf`](https://github.com/stella/stella/commit/53e54bf4f1629fa48a9429e4f792245fe75d5fa9) Thanks [@jan-kubica](https://github.com/jan-kubica)! - New `case-law lookup` command: resolve docket numbers and ECLIs to decisions, several per call, answering `found`, `ambiguous` or `not_found` per reference.

## 1.6.0

### Minor Changes

- [#3465](https://github.com/stella/stella/pull/3465) [`cbe581f`](https://github.com/stella/stella/commit/cbe581f2aedd1fa831eb32221a52daaca5cfcb46) Thanks [@jan-kubica](https://github.com/jan-kubica)! - case-law search takes several queries; case-law read takes several decision ids.

## 1.5.1

### Patch Changes

- [#3459](https://github.com/stella/stella/pull/3459) [`6253a8f`](https://github.com/stella/stella/commit/6253a8f4dd77aab29d375350d39f0f626f1ce760) Thanks [@jan-kubica](https://github.com/jan-kubica)! - A fourth MCP audience at `/mcp-law` lists only the public legal-corpus tools; the corpus legislation search no longer names the BOE connector.

## 1.5.0

### Minor Changes

- [#3456](https://github.com/stella/stella/pull/3456) [`1380c26`](https://github.com/stella/stella/commit/1380c26dcf52b162f0b8475d10b34fb26a36bdc3) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Corpus legislation search, point-in-time statute read, batch provision read and provision history become `legislation` commands; the BOE search moves to `legislation boe-search`.

## 1.4.1

### Patch Changes

- [#3423](https://github.com/stella/stella/pull/3423) [`a47047b`](https://github.com/stella/stella/commit/a47047b8bcda7b3d5161a48373f362d0f8a40d0c) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Legislation search now documents `CZE` (Czechia) as the supported jurisdiction. Unsupported jurisdiction filters return HTTP 400 with guidance to use `CZE` or omit the filter.

## 1.4.0

### Minor Changes

- [#3435](https://github.com/stella/stella/pull/3435) [`79b2d6f`](https://github.com/stella/stella/commit/79b2d6f8aa38df700555a2cdaa796af36c536433) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add agenda-kind filters and shared view-toolbar and Kanban proposal primitives. Expose cross-matter saved-view operations through the generated CLI capability tree. Replace view-switcher `renderActions` with `actionMenu`, which owns the vertical menu trigger. Hide redundant empty-lane counts and let empty Kanban cells scroll with the board.

## 1.3.1

### Patch Changes

- [#3420](https://github.com/stella/stella/pull/3420) [`3a33e1a`](https://github.com/stella/stella/commit/3a33e1a0399c6d8d698b3569d1ebcbd6e6fdb36c) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Expose optional copy names and replay-safe target identities for document duplication.

## 1.3.0

### Minor Changes

- [#3284](https://github.com/stella/stella/pull/3284) [`ce453f1`](https://github.com/stella/stella/commit/ce453f1abaf93f6543c6bafbceaab3795c1faa2a) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Case-law search accepts a sort and reports each hit's citation authority and matching-passage count; a new `case-law citations` capability lists what a decision cites or is cited by, with the treatment and the citing passage.

## 1.2.14

### Patch Changes

- [#3367](https://github.com/stella/stella/pull/3367) [`4181271`](https://github.com/stella/stella/commit/4181271d2de5f2e932deed74898b251b6239afa5) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Keep the CLI capability catalog in sync with the API contract.

## 1.2.13

### Patch Changes

- [#3236](https://github.com/stella/stella/pull/3236) [`00fd0ea`](https://github.com/stella/stella/commit/00fd0ea8b2cbc20f80ba4c11950487b74e3ffce1) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add the generated document comparison capability command.

## 1.2.12

### Patch Changes

- [#3268](https://github.com/stella/stella/pull/3268) [`d088d60`](https://github.com/stella/stella/commit/d088d602c7e377fa123c7aa5c9917a80bd47f77d) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Report the current document reference on verification-code matches and the continued numbering when a matter takes over a reference used before.

## 1.2.11

### Patch Changes

- [#3163](https://github.com/stella/stella/pull/3163) [`50a59c1`](https://github.com/stella/stella/commit/50a59c17a22fb018fd93c7608dd3055181d1da2c) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Describe verification-code-only document reference resolution and include document references in entity reads.

## 1.2.10

### Patch Changes

- [#3233](https://github.com/stella/stella/pull/3233) [`188b614`](https://github.com/stella/stella/commit/188b6147a2d9f4933011b850461c89885a291e74) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Remove source-language input from document translation commands so translation engines infer it from the document.

## 1.2.9

### Patch Changes

- [#3057](https://github.com/stella/stella/pull/3057) [`0913e83`](https://github.com/stella/stella/commit/0913e8385107e8195bbf4ef0baf17a2cd4599114) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Expose the source field selector when copying an entity to another matter.

## 1.2.8

### Patch Changes

- [#3210](https://github.com/stella/stella/pull/3210) [`d1f836f`](https://github.com/stella/stella/commit/d1f836f71183efd04f11c14beb973c44517f9550) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Require a country when searching public case law.

## 1.2.7

### Patch Changes

- [#3211](https://github.com/stella/stella/pull/3211) [`d8dc3fd`](https://github.com/stella/stella/commit/d8dc3fd78a7adb0d0893ee6cbf331e6898d78e53) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Route CLI arguments through the server's shared schema-derived normalization and validation boundary.

## 1.2.6

### Patch Changes

- [#3194](https://github.com/stella/stella/pull/3194) [`24656a2`](https://github.com/stella/stella/commit/24656a28a7e978e6893b4c7a922135bf93393215) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Accept search responses that state whether their result total is exact, estimated, or not counted.

## 1.2.5

### Patch Changes

- [#3189](https://github.com/stella/stella/pull/3189) [`26ae00b`](https://github.com/stella/stella/commit/26ae00bcda0ec6e97fd29e9efcc1a76a8f1186d0) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Align generated MCP behavioral annotations and destructive command metadata with the server registry.

## 1.2.4

### Patch Changes

- [#3190](https://github.com/stella/stella/pull/3190) [`96fc95e`](https://github.com/stella/stella/commit/96fc95ee219c193453df074546becc8474a0e6d2) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Describe the explicit decision text fields returned by the case-law decision command.

## 1.2.3

### Patch Changes

- [#3141](https://github.com/stella/stella/pull/3141) [`088e15d`](https://github.com/stella/stella/commit/088e15d2cb4c37a1b7f7e5380bbca62ab1704ce2) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Use Temporal for calendar calculations and wall clocks, with a native implementation when available and a bundled fallback otherwise. Preserve serialized timestamps and existing Date-based library interfaces.

## 1.2.2

### Patch Changes

- [#3137](https://github.com/stella/stella/pull/3137) [`63f962b`](https://github.com/stella/stella/commit/63f962b5ae86e0cf6cd6abc3342e68785b0951d5) Thanks [@jan-kubica](https://github.com/jan-kubica)! - The capability catalog follows the template surface: `templates.manifest` (embed a field manifest into an uploaded DOCX) is gone, and `templates.create`, `templates.save-document` and `templates.update` no longer take a `manifest` argument. A template's fields are what its markers declare.

## 1.2.1

### Patch Changes

- [#3101](https://github.com/stella/stella/pull/3101) [`c69d0a1`](https://github.com/stella/stella/commit/c69d0a11b544ac75c7362483428c5a2009676c81) Thanks [@jan-kubica](https://github.com/jan-kubica)! - The template marker grammar is the docxtpl dialect of Jinja: `{{ path | filter(…) }}` value markers whose filter chain carries the field configuration, `{% if %}` / `{% elif %}` / `{% else %}` / `{% endif %}`, `{% for alias in path %}` … `{% endfor %}` with `loop.*` counters, `{%p %}` and `{%tr %}` placement, and `clause()` / `num()` / `ref()` functions. The old `{{#each}}` / `{{#if}}` / `{{@…}}` forms are rejected as `legacy_marker` with the exact replacement named. The CLI catalog follows the tool schemas: composites (`parts`, `format`) leave the agent wire and a maximum constraint is at least 1.

## 1.2.0

### Minor Changes

- [#3045](https://github.com/stella/stella/pull/3045) [`d6c8fc9`](https://github.com/stella/stella/commit/d6c8fc910050b1b05f9adba3005ead156a705d30) Thanks [@shanehobson](https://github.com/shanehobson)! - The entity readers take a `find` filter: `entities.read-window`, the kanban group reader and the group-counts reader accept `body.find` (via `--input`, like the other structured body fields), narrowing rows to those whose displayed name or chosen columns contain a literal substring. It is not `search`, which ranks an asynchronous index of document titles and adds sort keys; a find filters exactly what the grid renders. `find.scope.type` `all` also matches the row's name, `columns` matches only `find.scope.propertyIds`. `find.term` is at least three characters once trimmed: the cells are read through a trigram index, which a shorter term cannot use.

## 1.1.0

### Minor Changes

- [#3102](https://github.com/stella/stella/pull/3102) [`41ef6b1`](https://github.com/stella/stella/commit/41ef6b1d5170789f1b93a8a4604d6d98633fb0b4) Thanks [@jan-kubica](https://github.com/jan-kubica)! - The server advertises API protocol 2 for the matter vocabulary, and this CLI
  speaks only protocol 2. A CLI built for protocol 1 now fails
  `compatibility check` against such a server with an upgrade message, instead
  of failing on its first renamed input.

### Patch Changes

- [#3077](https://github.com/stella/stella/pull/3077) [`a8c9cf8`](https://github.com/stella/stella/commit/a8c9cf89ef701eaac16a3c34a9d32b55d7a1e2dc) Thanks [@jan-kubica](https://github.com/jan-kubica)! - `template save` is replaced by `template create` and `template configure-fields`, one command per intent. Creating a template returns the fields the document declares and the exact configure call to make next, and passing a template id publishes a new version of that template rather than a second one. A field's "who fills this" is now a single `source` with a type (`person`, `ai`, `lookup`, `contact`, `party`, `matter`, `attorney`, `firm`, `formula`, `condition`) instead of six keys that could contradict each other, and configuring fields applies the entries it can and reports the rest per entry instead of refusing the whole call.

## 1.0.0

### Major Changes

- [#2996](https://github.com/stella/stella/pull/2996) [`a5babe4`](https://github.com/stella/stella/commit/a5babe46525dbea0431c8b777648fb530e918ba6) Thanks [@jan-kubica](https://github.com/jan-kubica)! - The client-engagement container is now called a matter everywhere the CLI speaks: `--workspace-id` and the synthesized `--workspace` become `--matter-id`, `stella capability workspaces …` becomes `stella capability matters …`, and the `matter_id` input alias is gone because `matter_id` is now the canonical name. This CLI requires a server on contract revision 2 or newer, and older CLIs cannot talk to one.

### Minor Changes

- [#2979](https://github.com/stella/stella/pull/2979) [`1ed653b`](https://github.com/stella/stella/commit/1ed653ba2c78b34f37e6a7af3b3c4765534e4cec) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Smooth out the first-session papercuts: a registry cache the current schema cannot read is rebuilt instead of skipped forever; unknown commands and flags exit 2 and auth failures exit 3 per the documented contract; a default login requests the working scope set; tables fit the terminal, drop empty columns, and flatten nested objects; tool errors name the flag instead of the wire field; `--input` accepts camelCase keys; help briefs use the tool's description, groups list their commands, and a Required line states each command's inputs; workspace-scoped capabilities all take `--workspace-id`; commands a deployment has gated off are marked in help and `tools list`; `upload` prints the finalized document like other saves; `auth whoami` says how long the session has left; `task delete` removes a task (new `delete_task` tool).

- [#3034](https://github.com/stella/stella/pull/3034) [`4348458`](https://github.com/stella/stella/commit/43484581996a74f8e25a655149bc01349c4866a5) Thanks [@jan-kubica](https://github.com/jan-kubica)! - `stella template save-filled` takes `--completion-mode`, the same strict-by-default policy `stella template fill` already had: a fill that leaves `{{placeholders}}` live now fails instead of writing that document into a matter. `stella template fill` takes `--output-mode` (`text` by default, `docx` for the base64 archive), so a fill no longer returns a large base64 blob unless it is asked for. `stella capability templates fill-preview` takes `values` as a JSON object through `--input` instead of a JSON-encoded string flag.

- [#3034](https://github.com/stella/stella/pull/3034) [`4348458`](https://github.com/stella/stella/commit/43484581996a74f8e25a655149bc01349c4866a5) Thanks [@jan-kubica](https://github.com/jan-kubica)! - `stella capability templates fill-to-matter` now takes `values` as a JSON object through `--input` instead of a JSON-encoded string flag, matching `fill-preview`. The stored-template fill endpoints behind them read the same object: `templates.fill-by-id`, `templates.fill-preview`, and `templates.fill-to-matter` take `values` as a field-path map in the JSON body, and the web fill form sends it that way. The multipart upload fill (`templates.fill`) keeps `values` JSON-encoded, because a multipart field carries a string.

- [#3034](https://github.com/stella/stella/pull/3034) [`4348458`](https://github.com/stella/stella/commit/43484581996a74f8e25a655149bc01349c4866a5) Thanks [@jan-kubica](https://github.com/jan-kubica)! - `stella reference show template-workflow` prints the end-to-end template procedure: author markers, create the template, read the discovered paths back, configure the fields, preview the fill, persist it into a matter, plus the completion gate and the marker rules that are easy to get wrong.

- [#2998](https://github.com/stella/stella/pull/2998) [`eef001f`](https://github.com/stella/stella/commit/eef001fefc5fb0c5d5c7e79b38338c90725b3e8f) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Translation goes through the background run: `stella capability document-translations runs-create` starts one and `runs-get` reads its progress and output. The synchronous `stella capability entities translate` command is gone.

### Patch Changes

- [#3034](https://github.com/stella/stella/pull/3034) [`4348458`](https://github.com/stella/stella/commit/43484581996a74f8e25a655149bc01349c4866a5) Thanks [@jan-kubica](https://github.com/jan-kubica)! - A registry lookup field addresses every one of its output formats by
  `{{path.key}}`, and the first format is additionally what a bare `{{path}}`
  marker renders. A template whose only markers are the keyed ones therefore
  fills from a single registry round trip, and `path` is configurable as the
  lookup even though no `{{path}}` marker exists. A path the document writes as
  its own marker is no longer dropped as a namespace parent, so it fills instead
  of surviving as literal text. Overlay rejections now travel in the structured
  error envelope with an `issues[].path` per offending entry, a lookup format key
  colliding with a separately configured field at the same path is refused naming
  both, and a field naming two derived sources says which two. The
  `list_templates` detail payload echoes the whole field configuration —
  registry, validation, binding source, `aiSeesDocument`, and the derived rules
  keyed the way the `fields` overlay names them. A loop item's configuration
  (`attorneys.name`) is kept as its own manifest field instead of being dropped
  with the array root it folds into, and a declared property sent as `null` is
  read as unset rather than as a value.

- [#3036](https://github.com/stella/stella/pull/3036) [`f16ae79`](https://github.com/stella/stella/commit/f16ae79a24ece98b378489728ee78047b080dc2b) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Every id a tool accepts that names a persisted record is now advertised as a UUID, so a malformed id is rejected before it is sent instead of failing on the server.

- [#3002](https://github.com/stella/stella/pull/3002) [`6302ab3`](https://github.com/stella/stella/commit/6302ab3adbd9dc9d88db26938f09bcad81e99f38) Thanks [@jan-kubica](https://github.com/jan-kubica)! - The work transition capability's description says that completing or cancelling the task a workflow review gate raised approves or rejects that gate.

- [#3034](https://github.com/stella/stella/pull/3034) [`4348458`](https://github.com/stella/stella/commit/43484581996a74f8e25a655149bc01349c4866a5) Thanks [@jan-kubica](https://github.com/jan-kubica)! - `template save`'s `--docx-base64` help now states that the flag carries the original file's bytes encoded verbatim, and that parts must never be stripped out to shrink it.

- [#3034](https://github.com/stella/stella/pull/3034) [`4348458`](https://github.com/stella/stella/commit/43484581996a74f8e25a655149bc01349c4866a5) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Clarify that updating a template manifest embeds it into a new stored DOCX version.

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
