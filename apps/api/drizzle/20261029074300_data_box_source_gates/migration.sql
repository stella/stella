-- requires: 20261029074200_data_box_sources
SET lock_timeout = '1s';
--> statement-breakpoint
SET statement_timeout = '10s';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.entity_feature_gate_graph() RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $graph$ SELECT $metadata${"entities":{"tableName":"entities","primaryKey":["id"],"projection":"jsonb_build_object('id', p.\"id\", 'workspace_id', p.\"workspace_id\", 'list_item_type', p.\"list_item_type\", 'entity_feature_gate', p.\"entity_feature_gate\")","refs":[],"ownWorkspace":true,"ownOrganization":false,"needsWorkspace":false,"needsOrganization":false,"order":0},"anonymization_allowlist_entries":{"tableName":"anonymization_allowlist_entries","primaryKey":["id"],"projection":"jsonb_build_object('id', p.\"id\", 'workspace_id', p.\"workspace_id\", 'organization_id', p.\"organization_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'entity_feature_workspace_ids', p.\"entity_feature_workspace_ids\", 'entity_id', p.\"entity_id\")","refs":[{"column":"entity_id","parent":"entities","hasForeignKey":true,"sameWorkspace":false,"sameOrganization":false}],"ownWorkspace":false,"ownOrganization":true,"needsWorkspace":true,"needsOrganization":false,"order":1},"entity_versions":{"tableName":"entity_versions","primaryKey":["id"],"projection":"jsonb_build_object('id', p.\"id\", 'workspace_id', p.\"workspace_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'entity_id', p.\"entity_id\")","refs":[{"column":"entity_id","parent":"entities","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":false,"needsWorkspace":false,"needsOrganization":false,"order":2},"cell_metadata":{"tableName":"cell_metadata","primaryKey":["entity_version_id","property_id"],"projection":"jsonb_build_object('workspace_id', p.\"workspace_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'entity_feature_workspace_ids', p.\"entity_feature_workspace_ids\", 'entity_version_id', p.\"entity_version_id\", 'property_id', p.\"property_id\")","refs":[{"column":"entity_version_id","parent":"entity_versions","hasForeignKey":true,"sameWorkspace":false,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":false,"needsWorkspace":true,"needsOrganization":false,"order":3},"correspondence":{"tableName":"correspondence","primaryKey":["id"],"projection":"jsonb_build_object('id', p.\"id\", 'workspace_id', p.\"workspace_id\", 'organization_id', p.\"organization_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'source_entity_id', p.\"source_entity_id\")","refs":[{"column":"source_entity_id","parent":"entities","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":true,"needsWorkspace":false,"needsOrganization":false,"order":4},"correspondence_attachments":{"tableName":"correspondence_attachments","primaryKey":["id"],"projection":"jsonb_build_object('id', p.\"id\", 'workspace_id', p.\"workspace_id\", 'organization_id', p.\"organization_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'correspondence_id', p.\"correspondence_id\", 'entity_id', p.\"entity_id\")","refs":[{"column":"correspondence_id","parent":"correspondence","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":true},{"column":"entity_id","parent":"entities","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":true,"needsWorkspace":false,"needsOrganization":false,"order":5},"correspondence_filers":{"tableName":"correspondence_filers","primaryKey":["id"],"projection":"jsonb_build_object('id', p.\"id\", 'workspace_id', p.\"workspace_id\", 'organization_id', p.\"organization_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'correspondence_id', p.\"correspondence_id\")","refs":[{"column":"correspondence_id","parent":"correspondence","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":true}],"ownWorkspace":true,"ownOrganization":true,"needsWorkspace":false,"needsOrganization":false,"order":6},"correspondence_sources":{"tableName":"correspondence_sources","primaryKey":["workspace_id","entity_id"],"projection":"jsonb_build_object('workspace_id', p.\"workspace_id\", 'organization_id', p.\"organization_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'correspondence_id', p.\"correspondence_id\", 'entity_id', p.\"entity_id\")","refs":[{"column":"correspondence_id","parent":"correspondence","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":true},{"column":"entity_id","parent":"entities","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":true,"needsWorkspace":false,"needsOrganization":false,"order":7},"desktop_edit_sessions":{"tableName":"desktop_edit_sessions","primaryKey":["id"],"projection":"jsonb_build_object('id', p.\"id\", 'workspace_id', p.\"workspace_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'entity_feature_workspace_ids', p.\"entity_feature_workspace_ids\", 'entity_id', p.\"entity_id\", 'base_version_id', p.\"base_version_id\", 'finalized_version_id', p.\"finalized_version_id\")","refs":[{"column":"entity_id","parent":"entities","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false},{"column":"base_version_id","parent":"entity_versions","hasForeignKey":true,"sameWorkspace":false,"sameOrganization":false},{"column":"finalized_version_id","parent":"entity_versions","hasForeignKey":true,"sameWorkspace":false,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":false,"needsWorkspace":true,"needsOrganization":false,"order":8},"desktop_edit_handoffs":{"tableName":"desktop_edit_handoffs","primaryKey":["id"],"projection":"jsonb_build_object('id', p.\"id\", 'workspace_id', p.\"workspace_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'entity_feature_workspace_ids', p.\"entity_feature_workspace_ids\", 'desktop_session_id', p.\"desktop_session_id\", 'entity_id', p.\"entity_id\")","refs":[{"column":"desktop_session_id","parent":"desktop_edit_sessions","hasForeignKey":true,"sameWorkspace":false,"sameOrganization":false},{"column":"entity_id","parent":"entities","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":false,"needsWorkspace":true,"needsOrganization":false,"order":9},"fields":{"tableName":"fields","primaryKey":["id"],"projection":"jsonb_build_object('id', p.\"id\", 'workspace_id', p.\"workspace_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'entity_feature_workspace_ids', p.\"entity_feature_workspace_ids\", 'entity_version_id', p.\"entity_version_id\")","refs":[{"column":"entity_version_id","parent":"entity_versions","hasForeignKey":true,"sameWorkspace":false,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":false,"needsWorkspace":true,"needsOrganization":false,"order":10},"document_processing_runs":{"tableName":"document_processing_runs","primaryKey":["id"],"projection":"jsonb_build_object('id', p.\"id\", 'workspace_id', p.\"workspace_id\", 'organization_id', p.\"organization_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'entity_feature_workspace_ids', p.\"entity_feature_workspace_ids\", 'entity_id', p.\"entity_id\", 'entity_version_id', p.\"entity_version_id\", 'field_id', p.\"field_id\")","refs":[{"column":"entity_id","parent":"entities","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false},{"column":"entity_version_id","parent":"entity_versions","hasForeignKey":true,"sameWorkspace":false,"sameOrganization":false},{"column":"field_id","parent":"fields","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":true,"needsWorkspace":true,"needsOrganization":false,"order":11},"document_review_parties":{"tableName":"document_review_parties","primaryKey":["id"],"projection":"jsonb_build_object('id', p.\"id\", 'workspace_id', p.\"workspace_id\", 'organization_id', p.\"organization_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'entity_feature_workspace_ids', p.\"entity_feature_workspace_ids\", 'entity_id', p.\"entity_id\", 'entity_version_id', p.\"entity_version_id\")","refs":[{"column":"entity_id","parent":"entities","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false},{"column":"entity_version_id","parent":"entity_versions","hasForeignKey":true,"sameWorkspace":false,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":true,"needsWorkspace":true,"needsOrganization":false,"order":12},"document_review_reference_passages":{"tableName":"document_review_reference_passages","primaryKey":["id"],"projection":"jsonb_build_object('id', p.\"id\", 'workspace_id', p.\"workspace_id\", 'organization_id', p.\"organization_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'entity_id', p.\"entity_id\")","refs":[{"column":"entity_id","parent":"entities","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":true,"needsWorkspace":false,"needsOrganization":false,"order":13},"document_translation_runs":{"tableName":"document_translation_runs","primaryKey":["id"],"projection":"jsonb_build_object('id', p.\"id\", 'workspace_id', p.\"workspace_id\", 'organization_id', p.\"organization_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'entity_feature_workspace_ids', p.\"entity_feature_workspace_ids\", 'entity_id', p.\"entity_id\")","refs":[{"column":"entity_id","parent":"entities","hasForeignKey":true,"sameWorkspace":false,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":true,"needsWorkspace":true,"needsOrganization":false,"order":14},"document_translation_units":{"tableName":"document_translation_units","primaryKey":["id"],"projection":"jsonb_build_object('id', p.\"id\", 'workspace_id', p.\"workspace_id\", 'organization_id', p.\"organization_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'entity_feature_workspace_ids', p.\"entity_feature_workspace_ids\", 'run_id', p.\"run_id\")","refs":[{"column":"run_id","parent":"document_translation_runs","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":true}],"ownWorkspace":true,"ownOrganization":true,"needsWorkspace":true,"needsOrganization":false,"order":15},"docx_suggestions":{"tableName":"docx_suggestions","primaryKey":["id"],"projection":"jsonb_build_object('id', p.\"id\", 'workspace_id', p.\"workspace_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'entity_id', p.\"entity_id\")","refs":[{"column":"entity_id","parent":"entities","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":false,"needsWorkspace":false,"needsOrganization":false,"order":16},"entity_links":{"tableName":"entity_links","primaryKey":["id"],"projection":"jsonb_build_object('id', p.\"id\", 'workspace_id', p.\"workspace_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'entity_feature_workspace_ids', p.\"entity_feature_workspace_ids\", 'source_entity_id', p.\"source_entity_id\", 'target_entity_id', p.\"target_entity_id\")","refs":[{"column":"source_entity_id","parent":"entities","hasForeignKey":true,"sameWorkspace":false,"sameOrganization":false},{"column":"target_entity_id","parent":"entities","hasForeignKey":true,"sameWorkspace":false,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":false,"needsWorkspace":true,"needsOrganization":false,"order":17},"entity_version_ai_summaries":{"tableName":"entity_version_ai_summaries","primaryKey":["id"],"projection":"jsonb_build_object('id', p.\"id\", 'workspace_id', p.\"workspace_id\", 'organization_id', p.\"organization_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'entity_feature_workspace_ids', p.\"entity_feature_workspace_ids\", 'entity_id', p.\"entity_id\", 'entity_version_id', p.\"entity_version_id\")","refs":[{"column":"entity_id","parent":"entities","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false},{"column":"entity_version_id","parent":"entity_versions","hasForeignKey":true,"sameWorkspace":false,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":true,"needsWorkspace":true,"needsOrganization":false,"order":18},"extracted_content":{"tableName":"extracted_content","primaryKey":["entity_id"],"projection":"jsonb_build_object('workspace_id', p.\"workspace_id\", 'organization_id', p.\"organization_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'entity_feature_workspace_ids', p.\"entity_feature_workspace_ids\", 'entity_id', p.\"entity_id\", 'source_entity_version_id', p.\"source_entity_version_id\", 'source_field_id', p.\"source_field_id\")","refs":[{"column":"entity_id","parent":"entities","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false},{"column":"source_entity_version_id","parent":"entity_versions","hasForeignKey":true,"sameWorkspace":false,"sameOrganization":false},{"column":"source_field_id","parent":"fields","hasForeignKey":true,"sameWorkspace":false,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":true,"needsWorkspace":true,"needsOrganization":false,"order":19},"file_chat_threads":{"tableName":"file_chat_threads","primaryKey":["id"],"projection":"jsonb_build_object('id', p.\"id\", 'workspace_id', p.\"workspace_id\", 'organization_id', p.\"organization_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'entity_feature_workspace_ids', p.\"entity_feature_workspace_ids\", 'entity_id', p.\"entity_id\", 'field_id', p.\"field_id\")","refs":[{"column":"entity_id","parent":"entities","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false},{"column":"field_id","parent":"fields","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":true,"needsWorkspace":true,"needsOrganization":false,"order":20},"flow_run_steps":{"tableName":"flow_run_steps","primaryKey":["id"],"projection":"jsonb_build_object('id', p.\"id\", 'workspace_id', p.\"workspace_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'entity_feature_workspace_ids', p.\"entity_feature_workspace_ids\", 'review_task_entity_id', p.\"review_task_entity_id\")","refs":[{"column":"review_task_entity_id","parent":"entities","hasForeignKey":true,"sameWorkspace":false,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":false,"needsWorkspace":true,"needsOrganization":false,"order":21},"folio_collab_rooms":{"tableName":"folio_collab_rooms","primaryKey":["id"],"projection":"jsonb_build_object('id', p.\"id\", 'workspace_id', p.\"workspace_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'entity_id', p.\"entity_id\", 'base_version_id', p.\"base_version_id\", 'source_version_id', p.\"source_version_id\")","refs":[{"column":"entity_id","parent":"entities","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false},{"column":"base_version_id","parent":"entity_versions","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false},{"column":"source_version_id","parent":"entity_versions","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":false,"needsWorkspace":false,"needsOrganization":false,"order":22},"folio_collab_contributions":{"tableName":"folio_collab_contributions","primaryKey":["id"],"projection":"jsonb_build_object('id', p.\"id\", 'workspace_id', p.\"workspace_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'entity_id', p.\"entity_id\", 'since_version_id', p.\"since_version_id\", 'room_id', p.\"room_id\")","refs":[{"column":"entity_id","parent":"entities","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false},{"column":"since_version_id","parent":"entity_versions","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false},{"column":"room_id","parent":"folio_collab_rooms","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":false,"needsWorkspace":false,"needsOrganization":false,"order":23},"folio_collab_publications":{"tableName":"folio_collab_publications","primaryKey":["id"],"projection":"jsonb_build_object('id', p.\"id\", 'workspace_id', p.\"workspace_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'entity_id', p.\"entity_id\", 'entity_version_id', p.\"entity_version_id\", 'room_id', p.\"room_id\")","refs":[{"column":"entity_id","parent":"entities","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false},{"column":"entity_version_id","parent":"entity_versions","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false},{"column":"room_id","parent":"folio_collab_rooms","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":false,"needsWorkspace":false,"needsOrganization":false,"order":24},"folio_collab_room_tokens":{"tableName":"folio_collab_room_tokens","primaryKey":["id"],"projection":"jsonb_build_object('id', p.\"id\", 'workspace_id', p.\"workspace_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'room_id', p.\"room_id\")","refs":[{"column":"room_id","parent":"folio_collab_rooms","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":false,"needsWorkspace":false,"needsOrganization":false,"order":25},"justifications":{"tableName":"justifications","primaryKey":["id"],"projection":"jsonb_build_object('id', p.\"id\", 'workspace_id', p.\"workspace_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'entity_feature_workspace_ids', p.\"entity_feature_workspace_ids\", 'field_id', p.\"field_id\")","refs":[{"column":"field_id","parent":"fields","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":false,"needsWorkspace":true,"needsOrganization":false,"order":26},"legal_list_verification_runs":{"tableName":"legal_list_verification_runs","primaryKey":["id"],"projection":"jsonb_build_object('id', p.\"id\", 'workspace_id', p.\"workspace_id\", 'organization_id', p.\"organization_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'entity_id', p.\"entity_id\")","refs":[{"column":"entity_id","parent":"entities","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":true,"needsWorkspace":false,"needsOrganization":false,"order":27},"legal_list_claims":{"tableName":"legal_list_claims","primaryKey":["id"],"projection":"jsonb_build_object('id', p.\"id\", 'workspace_id', p.\"workspace_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'entity_feature_organization_ids', p.\"entity_feature_organization_ids\", 'run_id', p.\"run_id\")","refs":[{"column":"run_id","parent":"legal_list_verification_runs","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":false,"needsWorkspace":false,"needsOrganization":true,"order":28},"legal_list_claim_review_events":{"tableName":"legal_list_claim_review_events","primaryKey":["id"],"projection":"jsonb_build_object('id', p.\"id\", 'workspace_id', p.\"workspace_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'entity_feature_organization_ids', p.\"entity_feature_organization_ids\", 'claim_id', p.\"claim_id\")","refs":[{"column":"claim_id","parent":"legal_list_claims","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":false,"needsWorkspace":false,"needsOrganization":true,"order":29},"legal_list_fact_details":{"tableName":"legal_list_fact_details","primaryKey":["item_entity_id"],"projection":"jsonb_build_object('workspace_id', p.\"workspace_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'item_entity_id', p.\"item_entity_id\")","refs":[{"column":"item_entity_id","parent":"entities","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":false,"needsWorkspace":false,"needsOrganization":false,"order":30},"legal_list_generation_candidates":{"tableName":"legal_list_generation_candidates","primaryKey":["id"],"projection":"jsonb_build_object('id', p.\"id\", 'workspace_id', p.\"workspace_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'entity_feature_workspace_ids', p.\"entity_feature_workspace_ids\", 'accepted_entity_id', p.\"accepted_entity_id\")","refs":[{"column":"accepted_entity_id","parent":"entities","hasForeignKey":true,"sameWorkspace":false,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":false,"needsWorkspace":true,"needsOrganization":false,"order":31},"legal_list_generation_candidate_sources":{"tableName":"legal_list_generation_candidate_sources","primaryKey":["id"],"projection":"jsonb_build_object('id', p.\"id\", 'workspace_id', p.\"workspace_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'entity_feature_workspace_ids', p.\"entity_feature_workspace_ids\", 'source_entity_id', p.\"source_entity_id\", 'source_entity_version_id', p.\"source_entity_version_id\", 'candidate_id', p.\"candidate_id\")","refs":[{"column":"source_entity_id","parent":"entities","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false},{"column":"source_entity_version_id","parent":"entity_versions","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false},{"column":"candidate_id","parent":"legal_list_generation_candidates","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":false,"needsWorkspace":true,"needsOrganization":false,"order":32},"legal_list_generation_sources":{"tableName":"legal_list_generation_sources","primaryKey":["id"],"projection":"jsonb_build_object('id', p.\"id\", 'workspace_id', p.\"workspace_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'source_entity_id', p.\"source_entity_id\", 'source_entity_version_id', p.\"source_entity_version_id\")","refs":[{"column":"source_entity_id","parent":"entities","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false},{"column":"source_entity_version_id","parent":"entity_versions","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":false,"needsWorkspace":false,"needsOrganization":false,"order":33},"legal_list_item_comments":{"tableName":"legal_list_item_comments","primaryKey":["id"],"projection":"jsonb_build_object('id', p.\"id\", 'workspace_id', p.\"workspace_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'item_entity_id', p.\"item_entity_id\")","refs":[{"column":"item_entity_id","parent":"entities","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":false,"needsWorkspace":false,"needsOrganization":false,"order":34},"legal_list_item_reviews":{"tableName":"legal_list_item_reviews","primaryKey":["id"],"projection":"jsonb_build_object('id', p.\"id\", 'workspace_id', p.\"workspace_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'item_entity_id', p.\"item_entity_id\")","refs":[{"column":"item_entity_id","parent":"entities","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":false,"needsWorkspace":false,"needsOrganization":false,"order":35},"legal_list_item_sources":{"tableName":"legal_list_item_sources","primaryKey":["id"],"projection":"jsonb_build_object('id', p.\"id\", 'workspace_id', p.\"workspace_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'item_entity_id', p.\"item_entity_id\", 'source_entity_id', p.\"source_entity_id\", 'source_entity_version_id', p.\"source_entity_version_id\")","refs":[{"column":"item_entity_id","parent":"entities","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false},{"column":"source_entity_id","parent":"entities","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false},{"column":"source_entity_version_id","parent":"entity_versions","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":false,"needsWorkspace":false,"needsOrganization":false,"order":36},"legal_list_items":{"tableName":"legal_list_items","primaryKey":["entity_id"],"projection":"jsonb_build_object('workspace_id', p.\"workspace_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'entity_id', p.\"entity_id\")","refs":[{"column":"entity_id","parent":"entities","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":false,"needsWorkspace":false,"needsOrganization":false,"order":37},"legal_list_verification_blocks":{"tableName":"legal_list_verification_blocks","primaryKey":["run_id","ordinal"],"projection":"jsonb_build_object('workspace_id', p.\"workspace_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'entity_feature_organization_ids', p.\"entity_feature_organization_ids\", 'run_id', p.\"run_id\", 'ordinal', p.\"ordinal\")","refs":[{"column":"run_id","parent":"legal_list_verification_runs","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":false,"needsWorkspace":false,"needsOrganization":true,"order":38},"legal_list_verification_read_receipts":{"tableName":"legal_list_verification_read_receipts","primaryKey":["organization_id","workspace_id","run_id","user_id"],"projection":"jsonb_build_object('workspace_id', p.\"workspace_id\", 'organization_id', p.\"organization_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'run_id', p.\"run_id\", 'user_id', p.\"user_id\")","refs":[{"column":"run_id","parent":"legal_list_verification_runs","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":true}],"ownWorkspace":true,"ownOrganization":true,"needsWorkspace":false,"needsOrganization":false,"order":39},"office_file_evidence":{"tableName":"office_file_evidence","primaryKey":["organization_id","workspace_id","entity_version_id","field_id","source_file_id","source_sha256_hex","parser_version"],"projection":"jsonb_build_object('workspace_id', p.\"workspace_id\", 'organization_id', p.\"organization_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'entity_feature_workspace_ids', p.\"entity_feature_workspace_ids\", 'entity_id', p.\"entity_id\", 'entity_version_id', p.\"entity_version_id\", 'field_id', p.\"field_id\", 'source_file_id', p.\"source_file_id\", 'source_sha256_hex', p.\"source_sha256_hex\", 'parser_version', p.\"parser_version\")","refs":[{"column":"entity_id","parent":"entities","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false},{"column":"entity_version_id","parent":"entity_versions","hasForeignKey":true,"sameWorkspace":false,"sameOrganization":false},{"column":"field_id","parent":"fields","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":true,"needsWorkspace":true,"needsOrganization":false,"order":40},"pdf_signing_sessions":{"tableName":"pdf_signing_sessions","primaryKey":["id"],"projection":"jsonb_build_object('id', p.\"id\", 'workspace_id', p.\"workspace_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'entity_feature_workspace_ids', p.\"entity_feature_workspace_ids\", 'entity_id', p.\"entity_id\", 'base_version_id', p.\"base_version_id\", 'finalized_version_id', p.\"finalized_version_id\")","refs":[{"column":"entity_id","parent":"entities","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false},{"column":"base_version_id","parent":"entity_versions","hasForeignKey":true,"sameWorkspace":false,"sameOrganization":false},{"column":"finalized_version_id","parent":"entity_versions","hasForeignKey":true,"sameWorkspace":false,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":false,"needsWorkspace":true,"needsOrganization":false,"order":41},"report_exports":{"tableName":"report_exports","primaryKey":["id"],"projection":"jsonb_build_object('id', p.\"id\", 'workspace_id', p.\"workspace_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'entity_feature_workspace_ids', p.\"entity_feature_workspace_ids\", 'result_entity_id', p.\"result_entity_id\", 'result_field_id', p.\"result_field_id\")","refs":[{"column":"result_entity_id","parent":"entities","hasForeignKey":true,"sameWorkspace":false,"sameOrganization":false},{"column":"result_field_id","parent":"fields","hasForeignKey":true,"sameWorkspace":false,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":false,"needsWorkspace":true,"needsOrganization":false,"order":42},"search_document_preview_passages":{"tableName":"search_document_preview_passages","primaryKey":["entity_id","generation","ordinal"],"projection":"jsonb_build_object('workspace_id', p.\"workspace_id\", 'organization_id', p.\"organization_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'entity_feature_workspace_ids', p.\"entity_feature_workspace_ids\", 'entity_id', p.\"entity_id\", 'generation', p.\"generation\", 'ordinal', p.\"ordinal\")","refs":[{"column":"entity_id","parent":"entities","hasForeignKey":true,"sameWorkspace":false,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":true,"needsWorkspace":true,"needsOrganization":false,"order":43},"search_documents":{"tableName":"search_documents","primaryKey":["entity_id"],"projection":"jsonb_build_object('workspace_id', p.\"workspace_id\", 'organization_id', p.\"organization_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'entity_feature_workspace_ids', p.\"entity_feature_workspace_ids\", 'entity_id', p.\"entity_id\")","refs":[{"column":"entity_id","parent":"entities","hasForeignKey":true,"sameWorkspace":false,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":true,"needsWorkspace":true,"needsOrganization":false,"order":44},"task_assignees":{"tableName":"task_assignees","primaryKey":["id"],"projection":"jsonb_build_object('id', p.\"id\", 'workspace_id', p.\"workspace_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'entity_feature_workspace_ids', p.\"entity_feature_workspace_ids\", 'entity_id', p.\"entity_id\")","refs":[{"column":"entity_id","parent":"entities","hasForeignKey":true,"sameWorkspace":false,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":false,"needsWorkspace":true,"needsOrganization":false,"order":45},"work_obligation_events":{"tableName":"work_obligation_events","primaryKey":["id"],"projection":"jsonb_build_object('id', p.\"id\", 'workspace_id', p.\"workspace_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'obligation_entity_id', p.\"obligation_entity_id\")","refs":[{"column":"obligation_entity_id","parent":"entities","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":false,"needsWorkspace":false,"needsOrganization":false,"order":46},"work_obligations":{"tableName":"work_obligations","primaryKey":["entity_id"],"projection":"jsonb_build_object('workspace_id', p.\"workspace_id\", 'entity_feature_gate', p.\"entity_feature_gate\", 'entity_id', p.\"entity_id\")","refs":[{"column":"entity_id","parent":"entities","hasForeignKey":true,"sameWorkspace":true,"sameOrganization":false}],"ownWorkspace":true,"ownOrganization":false,"needsWorkspace":false,"needsOrganization":false,"order":47}}$metadata$::jsonb $graph$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.entity_feature_gate_graph() FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT ("workspace_id", "organization_id", "entity_feature_gate", "correspondence_id", "entity_id"), UPDATE ("entity_feature_gate") ON public."correspondence_sources" TO stella_entity_gate;
--> statement-breakpoint
CREATE POLICY "entity_feature_gate_maintenance" ON "public"."correspondence_sources" AS PERMISSIVE FOR ALL TO "stella_entity_gate" USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY "workspace_entity_feature" ON "public"."correspondence_sources" AS RESTRICTIVE FOR ALL TO "stella" USING (("correspondence_sources"."entity_feature_gate" = 'open' OR ("correspondence_sources"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists')))) WITH CHECK (("correspondence_sources"."entity_feature_gate" = 'open' OR ("correspondence_sources"."entity_feature_gate" = 'legal-lists' AND (SELECT coalesce(nullif(current_setting('app.enabled_features', true), ''), '[]')::jsonb ? 'legal-lists'))));
--> statement-breakpoint
CREATE POLICY "review_reset_owner_select" ON "public"."correspondence_sources" AS PERMISSIVE FOR SELECT TO PUBLIC USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.correspondence_sources'::regclass) AND organization_id = nullif(current_setting('app.correspondence_review_reset_organization_id', true), ''));
--> statement-breakpoint
CREATE POLICY "review_reset_owner_delete" ON "public"."correspondence_sources" AS PERMISSIVE FOR DELETE TO PUBLIC USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.correspondence_sources'::regclass) AND organization_id = nullif(current_setting('app.correspondence_review_reset_organization_id', true), ''));
--> statement-breakpoint
CREATE POLICY "correspondence_sources_workspace_select" ON "public"."correspondence_sources" AS PERMISSIVE FOR SELECT TO "stella" USING (( CASE WHEN workspace_id = ANY( COALESCE( NULLIF( (SELECT pg_catalog.current_setting( 'app.workspace_ids', true )), '' )::uuid[], ARRAY[]::uuid[] ) ) THEN true ELSE workspace_id IN ( SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw ) END AND organization_id = (SELECT current_setting( 'app.organization_id', true )) ));
--> statement-breakpoint
CREATE POLICY "correspondence_sources_workspace_insert" ON "public"."correspondence_sources" AS PERMISSIVE FOR INSERT TO "stella" WITH CHECK (( CASE WHEN workspace_id = ANY( COALESCE( NULLIF( (SELECT pg_catalog.current_setting( 'app.workspace_ids', true )), '' )::uuid[], ARRAY[]::uuid[] ) ) THEN true ELSE workspace_id IN ( SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw ) END AND organization_id = (SELECT current_setting( 'app.organization_id', true )) ));
--> statement-breakpoint
CREATE POLICY "correspondence_sources_workspace_update" ON "public"."correspondence_sources" AS PERMISSIVE FOR UPDATE TO "stella" USING (( CASE WHEN workspace_id = ANY( COALESCE( NULLIF( (SELECT pg_catalog.current_setting( 'app.workspace_ids', true )), '' )::uuid[], ARRAY[]::uuid[] ) ) THEN true ELSE workspace_id IN ( SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw ) END AND organization_id = (SELECT current_setting( 'app.organization_id', true )) ));
--> statement-breakpoint
CREATE POLICY "correspondence_sources_workspace_delete" ON "public"."correspondence_sources" AS PERMISSIVE FOR DELETE TO "stella" USING (( CASE WHEN workspace_id = ANY( COALESCE( NULLIF( (SELECT pg_catalog.current_setting( 'app.workspace_ids', true )), '' )::uuid[], ARRAY[]::uuid[] ) ) THEN true ELSE workspace_id IN ( SELECT aw.authorized_workspace_id FROM public.stella_authorized_workspaces aw ) END AND organization_id = (SELECT current_setting( 'app.organization_id', true )) ));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public."correspondence_sources" TO stella;
--> statement-breakpoint
-- stella-migration-safety: reviewed grant-privileges - Temporarily permit the migrator to replace the private propagation function; runtime role switching is disabled before commit.
GRANT stella_entity_gate TO CURRENT_USER WITH SET TRUE;
--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO stella_entity_gate;
--> statement-breakpoint
SET LOCAL ROLE stella_entity_gate;
--> statement-breakpoint
-- stella-migration-safety: reviewed security-definer - Regenerate the existing fixed-search-path private-role routine to propagate source gates from the canonical schema graph.
CREATE OR REPLACE FUNCTION public.entity_feature_gate_propagate()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog SET row_security = on
SET plan_cache_mode = force_generic_plan SET jit = off AS $function$
DECLARE
  changed_ids uuid[];
  changed_workspace_ids uuid[];
  matching_children text[];
  child_name text;
BEGIN
  -- Generated by apps/api/scripts/generate-entity-feature-gate-propagation.ts.
  -- Generic plans cache statement shapes; relational membership permits hash
  -- semijoins for large ID batches instead of linear array tests per child.
  -- Cache descendant probes and writes; transition rows supply only IDs and
  -- gate inputs. Keep orphan repair and the parent SHARE-lock protocol intact.
  IF TG_TABLE_NAME = 'entities' THEN
    IF TG_OP = 'UPDATE' THEN
      WITH changed AS MATERIALIZED (
        SELECT o.id AS old_id, n.id AS new_id
        FROM entity_feature_old_rows o FULL JOIN entity_feature_new_rows n USING (id)
        WHERE ROW(o."id", o."list_item_type", o."workspace_id") IS DISTINCT FROM ROW(n."id", n."list_item_type", n."workspace_id"))
      SELECT ARRAY(SELECT old_id FROM changed WHERE old_id IS NOT NULL
          UNION SELECT new_id FROM changed WHERE new_id IS NOT NULL),
        ARRAY(SELECT o.workspace_id FROM entity_feature_old_rows o
          UNION SELECT n.workspace_id FROM entity_feature_new_rows n)
        INTO changed_ids, changed_workspace_ids;
    ELSIF TG_OP = 'DELETE' THEN
      SELECT ARRAY(SELECT id FROM entity_feature_old_rows),
        ARRAY(SELECT DISTINCT o.workspace_id FROM entity_feature_old_rows o)
        INTO changed_ids, changed_workspace_ids;
    ELSE
      SELECT ARRAY(SELECT id FROM entity_feature_new_rows),
        ARRAY(SELECT DISTINCT n.workspace_id FROM entity_feature_new_rows n)
        INTO changed_ids, changed_workspace_ids;
    END IF;
    IF cardinality(changed_ids) = 0 THEN RETURN NULL; END IF;
    IF TG_OP <> 'INSERT' AND current_setting('transaction_isolation') <> 'read committed' THEN
      RAISE EXCEPTION 'Entity feature propagation requires a current snapshot'
        USING ERRCODE = '40001';
    END IF;
    SELECT ARRAY(SELECT candidates.child_name FROM (
        SELECT 'anonymization_allowlist_entries'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."anonymization_allowlist_entries" c WHERE (c."entity_id" IN (SELECT unnest(changed_ids))))
        UNION ALL
        SELECT 'correspondence'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."correspondence" c WHERE (c."source_entity_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids))))
        UNION ALL
        SELECT 'correspondence_attachments'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."correspondence_attachments" c WHERE (c."entity_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids))))
        UNION ALL
        SELECT 'correspondence_sources'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."correspondence_sources" c WHERE (c."entity_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids))))
        UNION ALL
        SELECT 'desktop_edit_handoffs'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."desktop_edit_handoffs" c WHERE (c."entity_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids))))
        UNION ALL
        SELECT 'desktop_edit_sessions'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."desktop_edit_sessions" c WHERE (c."entity_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids))))
        UNION ALL
        SELECT 'document_processing_runs'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."document_processing_runs" c WHERE (c."entity_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids))))
        UNION ALL
        SELECT 'document_review_parties'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."document_review_parties" c WHERE (c."entity_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids))))
        UNION ALL
        SELECT 'document_review_reference_passages'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."document_review_reference_passages" c WHERE (c."entity_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids))))
        UNION ALL
        SELECT 'document_translation_runs'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."document_translation_runs" c WHERE (c."entity_id" IN (SELECT unnest(changed_ids))))
        UNION ALL
        SELECT 'docx_suggestions'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."docx_suggestions" c WHERE (c."entity_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids))))
        UNION ALL
        SELECT 'entity_links'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."entity_links" c WHERE (c."source_entity_id" IN (SELECT unnest(changed_ids))) OR (c."target_entity_id" IN (SELECT unnest(changed_ids))))
        UNION ALL
        SELECT 'entity_version_ai_summaries'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."entity_version_ai_summaries" c WHERE (c."entity_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids))))
        UNION ALL
        SELECT 'entity_versions'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."entity_versions" c WHERE (c."entity_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids))))
        UNION ALL
        SELECT 'extracted_content'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."extracted_content" c WHERE (c."entity_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids))))
        UNION ALL
        SELECT 'file_chat_threads'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."file_chat_threads" c WHERE (c."entity_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids))))
        UNION ALL
        SELECT 'flow_run_steps'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."flow_run_steps" c WHERE (c."review_task_entity_id" IN (SELECT unnest(changed_ids))))
        UNION ALL
        SELECT 'folio_collab_contributions'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."folio_collab_contributions" c WHERE (c."entity_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids))))
        UNION ALL
        SELECT 'folio_collab_publications'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."folio_collab_publications" c WHERE (c."entity_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids))))
        UNION ALL
        SELECT 'folio_collab_rooms'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."folio_collab_rooms" c WHERE (c."entity_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids))))
        UNION ALL
        SELECT 'legal_list_fact_details'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."legal_list_fact_details" c WHERE (c."item_entity_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids))))
        UNION ALL
        SELECT 'legal_list_generation_candidate_sources'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."legal_list_generation_candidate_sources" c WHERE (c."source_entity_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids))))
        UNION ALL
        SELECT 'legal_list_generation_candidates'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."legal_list_generation_candidates" c WHERE (c."accepted_entity_id" IN (SELECT unnest(changed_ids))))
        UNION ALL
        SELECT 'legal_list_generation_sources'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."legal_list_generation_sources" c WHERE (c."source_entity_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids))))
        UNION ALL
        SELECT 'legal_list_item_comments'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."legal_list_item_comments" c WHERE (c."item_entity_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids))))
        UNION ALL
        SELECT 'legal_list_item_reviews'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."legal_list_item_reviews" c WHERE (c."item_entity_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids))))
        UNION ALL
        SELECT 'legal_list_item_sources'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."legal_list_item_sources" c WHERE (c."item_entity_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids))) OR (c."source_entity_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids))))
        UNION ALL
        SELECT 'legal_list_items'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."legal_list_items" c WHERE (c."entity_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids))))
        UNION ALL
        SELECT 'legal_list_verification_runs'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."legal_list_verification_runs" c WHERE (c."entity_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids))))
        UNION ALL
        SELECT 'office_file_evidence'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."office_file_evidence" c WHERE (c."entity_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids))))
        UNION ALL
        SELECT 'pdf_signing_sessions'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."pdf_signing_sessions" c WHERE (c."entity_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids))))
        UNION ALL
        SELECT 'report_exports'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."report_exports" c WHERE (c."result_entity_id" IN (SELECT unnest(changed_ids))))
        UNION ALL
        SELECT 'search_document_preview_passages'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."search_document_preview_passages" c WHERE (c."entity_id" IN (SELECT unnest(changed_ids))))
        UNION ALL
        SELECT 'search_documents'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."search_documents" c WHERE (c."entity_id" IN (SELECT unnest(changed_ids))))
        UNION ALL
        SELECT 'task_assignees'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."task_assignees" c WHERE (c."entity_id" IN (SELECT unnest(changed_ids))))
        UNION ALL
        SELECT 'work_obligation_events'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."work_obligation_events" c WHERE (c."obligation_entity_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids))))
        UNION ALL
        SELECT 'work_obligations'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."work_obligations" c WHERE (c."entity_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids))))) candidates ORDER BY candidates.child_name)
      INTO matching_children;
    FOREACH child_name IN ARRAY matching_children LOOP
      IF child_name = 'anonymization_allowlist_entries' THEN
          UPDATE public."anonymization_allowlist_entries" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."entity_id" IN (SELECT unnest(changed_ids)));
      ELSIF child_name = 'correspondence' THEN
          UPDATE public."correspondence" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."source_entity_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids)));
      ELSIF child_name = 'correspondence_attachments' THEN
          UPDATE public."correspondence_attachments" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."entity_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids)));
      ELSIF child_name = 'correspondence_sources' THEN
          UPDATE public."correspondence_sources" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."entity_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids)));
      ELSIF child_name = 'desktop_edit_handoffs' THEN
          UPDATE public."desktop_edit_handoffs" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."entity_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids)));
      ELSIF child_name = 'desktop_edit_sessions' THEN
          UPDATE public."desktop_edit_sessions" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."entity_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids)));
      ELSIF child_name = 'document_processing_runs' THEN
          UPDATE public."document_processing_runs" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."entity_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids)));
      ELSIF child_name = 'document_review_parties' THEN
          UPDATE public."document_review_parties" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."entity_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids)));
      ELSIF child_name = 'document_review_reference_passages' THEN
          UPDATE public."document_review_reference_passages" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."entity_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids)));
      ELSIF child_name = 'document_translation_runs' THEN
          UPDATE public."document_translation_runs" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."entity_id" IN (SELECT unnest(changed_ids)));
      ELSIF child_name = 'docx_suggestions' THEN
          UPDATE public."docx_suggestions" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."entity_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids)));
      ELSIF child_name = 'entity_links' THEN
          UPDATE public."entity_links" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."source_entity_id" IN (SELECT unnest(changed_ids))) OR (c."target_entity_id" IN (SELECT unnest(changed_ids)));
      ELSIF child_name = 'entity_version_ai_summaries' THEN
          UPDATE public."entity_version_ai_summaries" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."entity_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids)));
      ELSIF child_name = 'entity_versions' THEN
          UPDATE public."entity_versions" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."entity_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids)));
      ELSIF child_name = 'extracted_content' THEN
          UPDATE public."extracted_content" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."entity_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids)));
      ELSIF child_name = 'file_chat_threads' THEN
          UPDATE public."file_chat_threads" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."entity_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids)));
      ELSIF child_name = 'flow_run_steps' THEN
          UPDATE public."flow_run_steps" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."review_task_entity_id" IN (SELECT unnest(changed_ids)));
      ELSIF child_name = 'folio_collab_contributions' THEN
          UPDATE public."folio_collab_contributions" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."entity_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids)));
      ELSIF child_name = 'folio_collab_publications' THEN
          UPDATE public."folio_collab_publications" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."entity_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids)));
      ELSIF child_name = 'folio_collab_rooms' THEN
          UPDATE public."folio_collab_rooms" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."entity_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids)));
      ELSIF child_name = 'legal_list_fact_details' THEN
          UPDATE public."legal_list_fact_details" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."item_entity_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids)));
      ELSIF child_name = 'legal_list_generation_candidate_sources' THEN
          UPDATE public."legal_list_generation_candidate_sources" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."source_entity_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids)));
      ELSIF child_name = 'legal_list_generation_candidates' THEN
          UPDATE public."legal_list_generation_candidates" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."accepted_entity_id" IN (SELECT unnest(changed_ids)));
      ELSIF child_name = 'legal_list_generation_sources' THEN
          UPDATE public."legal_list_generation_sources" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."source_entity_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids)));
      ELSIF child_name = 'legal_list_item_comments' THEN
          UPDATE public."legal_list_item_comments" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."item_entity_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids)));
      ELSIF child_name = 'legal_list_item_reviews' THEN
          UPDATE public."legal_list_item_reviews" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."item_entity_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids)));
      ELSIF child_name = 'legal_list_item_sources' THEN
          UPDATE public."legal_list_item_sources" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."item_entity_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids))) OR (c."source_entity_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids)));
      ELSIF child_name = 'legal_list_items' THEN
          UPDATE public."legal_list_items" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."entity_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids)));
      ELSIF child_name = 'legal_list_verification_runs' THEN
          UPDATE public."legal_list_verification_runs" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."entity_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids)));
      ELSIF child_name = 'office_file_evidence' THEN
          UPDATE public."office_file_evidence" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."entity_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids)));
      ELSIF child_name = 'pdf_signing_sessions' THEN
          UPDATE public."pdf_signing_sessions" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."entity_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids)));
      ELSIF child_name = 'report_exports' THEN
          UPDATE public."report_exports" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."result_entity_id" IN (SELECT unnest(changed_ids)));
      ELSIF child_name = 'search_document_preview_passages' THEN
          UPDATE public."search_document_preview_passages" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."entity_id" IN (SELECT unnest(changed_ids)));
      ELSIF child_name = 'search_documents' THEN
          UPDATE public."search_documents" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."entity_id" IN (SELECT unnest(changed_ids)));
      ELSIF child_name = 'task_assignees' THEN
          UPDATE public."task_assignees" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."entity_id" IN (SELECT unnest(changed_ids)));
      ELSIF child_name = 'work_obligation_events' THEN
          UPDATE public."work_obligation_events" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."obligation_entity_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids)));
      ELSIF child_name = 'work_obligations' THEN
          UPDATE public."work_obligations" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."entity_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids)));
      ELSE
        RAISE EXCEPTION 'Unknown entity feature child %', child_name USING ERRCODE = 'XX000';
      END IF;
    END LOOP;
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME = 'entity_versions' THEN
    IF TG_OP = 'UPDATE' THEN
      WITH changed AS MATERIALIZED (
        SELECT o.id AS old_id, n.id AS new_id
        FROM entity_feature_old_rows o FULL JOIN entity_feature_new_rows n USING (id)
        WHERE ROW(o."id", o."entity_feature_gate", o."workspace_id") IS DISTINCT FROM ROW(n."id", n."entity_feature_gate", n."workspace_id"))
      SELECT ARRAY(SELECT old_id FROM changed WHERE old_id IS NOT NULL
          UNION SELECT new_id FROM changed WHERE new_id IS NOT NULL),
        ARRAY(SELECT o.workspace_id FROM entity_feature_old_rows o
          UNION SELECT n.workspace_id FROM entity_feature_new_rows n)
        INTO changed_ids, changed_workspace_ids;
    ELSIF TG_OP = 'DELETE' THEN
      SELECT ARRAY(SELECT id FROM entity_feature_old_rows),
        ARRAY(SELECT DISTINCT o.workspace_id FROM entity_feature_old_rows o)
        INTO changed_ids, changed_workspace_ids;
    ELSE
      SELECT ARRAY(SELECT id FROM entity_feature_new_rows),
        ARRAY(SELECT DISTINCT n.workspace_id FROM entity_feature_new_rows n)
        INTO changed_ids, changed_workspace_ids;
    END IF;
    IF cardinality(changed_ids) = 0 THEN RETURN NULL; END IF;
    IF TG_OP <> 'INSERT' AND current_setting('transaction_isolation') <> 'read committed' THEN
      RAISE EXCEPTION 'Entity feature propagation requires a current snapshot'
        USING ERRCODE = '40001';
    END IF;
    SELECT ARRAY(SELECT candidates.child_name FROM (
        SELECT 'cell_metadata'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."cell_metadata" c WHERE (c."entity_version_id" IN (SELECT unnest(changed_ids))))
        UNION ALL
        SELECT 'desktop_edit_sessions'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."desktop_edit_sessions" c WHERE (c."base_version_id" IN (SELECT unnest(changed_ids))) OR (c."finalized_version_id" IN (SELECT unnest(changed_ids))))
        UNION ALL
        SELECT 'document_processing_runs'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."document_processing_runs" c WHERE (c."entity_version_id" IN (SELECT unnest(changed_ids))))
        UNION ALL
        SELECT 'document_review_parties'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."document_review_parties" c WHERE (c."entity_version_id" IN (SELECT unnest(changed_ids))))
        UNION ALL
        SELECT 'entity_version_ai_summaries'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."entity_version_ai_summaries" c WHERE (c."entity_version_id" IN (SELECT unnest(changed_ids))))
        UNION ALL
        SELECT 'extracted_content'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."extracted_content" c WHERE (c."source_entity_version_id" IN (SELECT unnest(changed_ids))))
        UNION ALL
        SELECT 'fields'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."fields" c WHERE (c."entity_version_id" IN (SELECT unnest(changed_ids))))
        UNION ALL
        SELECT 'folio_collab_contributions'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."folio_collab_contributions" c WHERE (c."since_version_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids))))
        UNION ALL
        SELECT 'folio_collab_publications'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."folio_collab_publications" c WHERE (c."entity_version_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids))))
        UNION ALL
        SELECT 'folio_collab_rooms'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."folio_collab_rooms" c WHERE (c."base_version_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids))) OR (c."source_version_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids))))
        UNION ALL
        SELECT 'legal_list_generation_candidate_sources'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."legal_list_generation_candidate_sources" c WHERE (c."source_entity_version_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids))))
        UNION ALL
        SELECT 'legal_list_generation_sources'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."legal_list_generation_sources" c WHERE (c."source_entity_version_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids))))
        UNION ALL
        SELECT 'legal_list_item_sources'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."legal_list_item_sources" c WHERE (c."source_entity_version_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids))))
        UNION ALL
        SELECT 'office_file_evidence'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."office_file_evidence" c WHERE (c."entity_version_id" IN (SELECT unnest(changed_ids))))
        UNION ALL
        SELECT 'pdf_signing_sessions'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."pdf_signing_sessions" c WHERE (c."base_version_id" IN (SELECT unnest(changed_ids))) OR (c."finalized_version_id" IN (SELECT unnest(changed_ids))))) candidates ORDER BY candidates.child_name)
      INTO matching_children;
    FOREACH child_name IN ARRAY matching_children LOOP
      IF child_name = 'cell_metadata' THEN
          UPDATE public."cell_metadata" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."entity_version_id" IN (SELECT unnest(changed_ids)));
      ELSIF child_name = 'desktop_edit_sessions' THEN
          UPDATE public."desktop_edit_sessions" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."base_version_id" IN (SELECT unnest(changed_ids))) OR (c."finalized_version_id" IN (SELECT unnest(changed_ids)));
      ELSIF child_name = 'document_processing_runs' THEN
          UPDATE public."document_processing_runs" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."entity_version_id" IN (SELECT unnest(changed_ids)));
      ELSIF child_name = 'document_review_parties' THEN
          UPDATE public."document_review_parties" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."entity_version_id" IN (SELECT unnest(changed_ids)));
      ELSIF child_name = 'entity_version_ai_summaries' THEN
          UPDATE public."entity_version_ai_summaries" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."entity_version_id" IN (SELECT unnest(changed_ids)));
      ELSIF child_name = 'extracted_content' THEN
          UPDATE public."extracted_content" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."source_entity_version_id" IN (SELECT unnest(changed_ids)));
      ELSIF child_name = 'fields' THEN
          UPDATE public."fields" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."entity_version_id" IN (SELECT unnest(changed_ids)));
      ELSIF child_name = 'folio_collab_contributions' THEN
          UPDATE public."folio_collab_contributions" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."since_version_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids)));
      ELSIF child_name = 'folio_collab_publications' THEN
          UPDATE public."folio_collab_publications" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."entity_version_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids)));
      ELSIF child_name = 'folio_collab_rooms' THEN
          UPDATE public."folio_collab_rooms" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."base_version_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids))) OR (c."source_version_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids)));
      ELSIF child_name = 'legal_list_generation_candidate_sources' THEN
          UPDATE public."legal_list_generation_candidate_sources" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."source_entity_version_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids)));
      ELSIF child_name = 'legal_list_generation_sources' THEN
          UPDATE public."legal_list_generation_sources" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."source_entity_version_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids)));
      ELSIF child_name = 'legal_list_item_sources' THEN
          UPDATE public."legal_list_item_sources" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."source_entity_version_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids)));
      ELSIF child_name = 'office_file_evidence' THEN
          UPDATE public."office_file_evidence" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."entity_version_id" IN (SELECT unnest(changed_ids)));
      ELSIF child_name = 'pdf_signing_sessions' THEN
          UPDATE public."pdf_signing_sessions" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."base_version_id" IN (SELECT unnest(changed_ids))) OR (c."finalized_version_id" IN (SELECT unnest(changed_ids)));
      ELSE
        RAISE EXCEPTION 'Unknown entity feature child %', child_name USING ERRCODE = 'XX000';
      END IF;
    END LOOP;
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME = 'correspondence' THEN
    IF TG_OP = 'UPDATE' THEN
      WITH changed AS MATERIALIZED (
        SELECT o.id AS old_id, n.id AS new_id
        FROM entity_feature_old_rows o FULL JOIN entity_feature_new_rows n USING (id)
        WHERE ROW(o."id", o."entity_feature_gate", o."workspace_id", o."organization_id") IS DISTINCT FROM ROW(n."id", n."entity_feature_gate", n."workspace_id", n."organization_id"))
      SELECT ARRAY(SELECT old_id FROM changed WHERE old_id IS NOT NULL
          UNION SELECT new_id FROM changed WHERE new_id IS NOT NULL),
        ARRAY(SELECT o.workspace_id FROM entity_feature_old_rows o
          UNION SELECT n.workspace_id FROM entity_feature_new_rows n)
        INTO changed_ids, changed_workspace_ids;
    ELSIF TG_OP = 'DELETE' THEN
      SELECT ARRAY(SELECT id FROM entity_feature_old_rows),
        ARRAY(SELECT DISTINCT o.workspace_id FROM entity_feature_old_rows o)
        INTO changed_ids, changed_workspace_ids;
    ELSE
      SELECT ARRAY(SELECT id FROM entity_feature_new_rows),
        ARRAY(SELECT DISTINCT n.workspace_id FROM entity_feature_new_rows n)
        INTO changed_ids, changed_workspace_ids;
    END IF;
    IF cardinality(changed_ids) = 0 THEN RETURN NULL; END IF;
    IF TG_OP <> 'INSERT' AND current_setting('transaction_isolation') <> 'read committed' THEN
      RAISE EXCEPTION 'Entity feature propagation requires a current snapshot'
        USING ERRCODE = '40001';
    END IF;
    SELECT ARRAY(SELECT candidates.child_name FROM (
        SELECT 'correspondence_attachments'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."correspondence_attachments" c WHERE (c."correspondence_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids))))
        UNION ALL
        SELECT 'correspondence_filers'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."correspondence_filers" c WHERE (c."correspondence_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids))))
        UNION ALL
        SELECT 'correspondence_sources'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."correspondence_sources" c WHERE (c."correspondence_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids))))) candidates ORDER BY candidates.child_name)
      INTO matching_children;
    FOREACH child_name IN ARRAY matching_children LOOP
      IF child_name = 'correspondence_attachments' THEN
          UPDATE public."correspondence_attachments" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."correspondence_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids)));
      ELSIF child_name = 'correspondence_filers' THEN
          UPDATE public."correspondence_filers" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."correspondence_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids)));
      ELSIF child_name = 'correspondence_sources' THEN
          UPDATE public."correspondence_sources" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."correspondence_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids)));
      ELSE
        RAISE EXCEPTION 'Unknown entity feature child %', child_name USING ERRCODE = 'XX000';
      END IF;
    END LOOP;
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME = 'desktop_edit_sessions' THEN
    IF TG_OP = 'UPDATE' THEN
      WITH changed AS MATERIALIZED (
        SELECT o.id AS old_id, n.id AS new_id
        FROM entity_feature_old_rows o FULL JOIN entity_feature_new_rows n USING (id)
        WHERE ROW(o."id", o."entity_feature_gate", o."workspace_id", o."entity_feature_workspace_ids") IS DISTINCT FROM ROW(n."id", n."entity_feature_gate", n."workspace_id", n."entity_feature_workspace_ids"))
      SELECT ARRAY(SELECT old_id FROM changed WHERE old_id IS NOT NULL
          UNION SELECT new_id FROM changed WHERE new_id IS NOT NULL),
        ARRAY(SELECT o.workspace_id FROM entity_feature_old_rows o
          UNION SELECT n.workspace_id FROM entity_feature_new_rows n)
        INTO changed_ids, changed_workspace_ids;
    ELSIF TG_OP = 'DELETE' THEN
      SELECT ARRAY(SELECT id FROM entity_feature_old_rows),
        ARRAY(SELECT DISTINCT o.workspace_id FROM entity_feature_old_rows o)
        INTO changed_ids, changed_workspace_ids;
    ELSE
      SELECT ARRAY(SELECT id FROM entity_feature_new_rows),
        ARRAY(SELECT DISTINCT n.workspace_id FROM entity_feature_new_rows n)
        INTO changed_ids, changed_workspace_ids;
    END IF;
    IF cardinality(changed_ids) = 0 THEN RETURN NULL; END IF;
    IF TG_OP <> 'INSERT' AND current_setting('transaction_isolation') <> 'read committed' THEN
      RAISE EXCEPTION 'Entity feature propagation requires a current snapshot'
        USING ERRCODE = '40001';
    END IF;
    SELECT ARRAY(SELECT candidates.child_name FROM (
        SELECT 'desktop_edit_handoffs'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."desktop_edit_handoffs" c WHERE (c."desktop_session_id" IN (SELECT unnest(changed_ids))))) candidates ORDER BY candidates.child_name)
      INTO matching_children;
    FOREACH child_name IN ARRAY matching_children LOOP
      IF child_name = 'desktop_edit_handoffs' THEN
          UPDATE public."desktop_edit_handoffs" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."desktop_session_id" IN (SELECT unnest(changed_ids)));
      ELSE
        RAISE EXCEPTION 'Unknown entity feature child %', child_name USING ERRCODE = 'XX000';
      END IF;
    END LOOP;
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME = 'fields' THEN
    IF TG_OP = 'UPDATE' THEN
      WITH changed AS MATERIALIZED (
        SELECT o.id AS old_id, n.id AS new_id
        FROM entity_feature_old_rows o FULL JOIN entity_feature_new_rows n USING (id)
        WHERE ROW(o."id", o."entity_feature_gate", o."workspace_id", o."entity_feature_workspace_ids") IS DISTINCT FROM ROW(n."id", n."entity_feature_gate", n."workspace_id", n."entity_feature_workspace_ids"))
      SELECT ARRAY(SELECT old_id FROM changed WHERE old_id IS NOT NULL
          UNION SELECT new_id FROM changed WHERE new_id IS NOT NULL),
        ARRAY(SELECT o.workspace_id FROM entity_feature_old_rows o
          UNION SELECT n.workspace_id FROM entity_feature_new_rows n)
        INTO changed_ids, changed_workspace_ids;
    ELSIF TG_OP = 'DELETE' THEN
      SELECT ARRAY(SELECT id FROM entity_feature_old_rows),
        ARRAY(SELECT DISTINCT o.workspace_id FROM entity_feature_old_rows o)
        INTO changed_ids, changed_workspace_ids;
    ELSE
      SELECT ARRAY(SELECT id FROM entity_feature_new_rows),
        ARRAY(SELECT DISTINCT n.workspace_id FROM entity_feature_new_rows n)
        INTO changed_ids, changed_workspace_ids;
    END IF;
    IF cardinality(changed_ids) = 0 THEN RETURN NULL; END IF;
    IF TG_OP <> 'INSERT' AND current_setting('transaction_isolation') <> 'read committed' THEN
      RAISE EXCEPTION 'Entity feature propagation requires a current snapshot'
        USING ERRCODE = '40001';
    END IF;
    SELECT ARRAY(SELECT candidates.child_name FROM (
        SELECT 'document_processing_runs'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."document_processing_runs" c WHERE (c."field_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids))))
        UNION ALL
        SELECT 'extracted_content'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."extracted_content" c WHERE (c."source_field_id" IN (SELECT unnest(changed_ids))))
        UNION ALL
        SELECT 'file_chat_threads'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."file_chat_threads" c WHERE (c."field_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids))))
        UNION ALL
        SELECT 'justifications'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."justifications" c WHERE (c."field_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids))))
        UNION ALL
        SELECT 'office_file_evidence'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."office_file_evidence" c WHERE (c."field_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids))))
        UNION ALL
        SELECT 'report_exports'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."report_exports" c WHERE (c."result_field_id" IN (SELECT unnest(changed_ids))))) candidates ORDER BY candidates.child_name)
      INTO matching_children;
    FOREACH child_name IN ARRAY matching_children LOOP
      IF child_name = 'document_processing_runs' THEN
          UPDATE public."document_processing_runs" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."field_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids)));
      ELSIF child_name = 'extracted_content' THEN
          UPDATE public."extracted_content" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."source_field_id" IN (SELECT unnest(changed_ids)));
      ELSIF child_name = 'file_chat_threads' THEN
          UPDATE public."file_chat_threads" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."field_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids)));
      ELSIF child_name = 'justifications' THEN
          UPDATE public."justifications" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."field_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids)));
      ELSIF child_name = 'office_file_evidence' THEN
          UPDATE public."office_file_evidence" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."field_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids)));
      ELSIF child_name = 'report_exports' THEN
          UPDATE public."report_exports" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."result_field_id" IN (SELECT unnest(changed_ids)));
      ELSE
        RAISE EXCEPTION 'Unknown entity feature child %', child_name USING ERRCODE = 'XX000';
      END IF;
    END LOOP;
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME = 'document_translation_runs' THEN
    IF TG_OP = 'UPDATE' THEN
      WITH changed AS MATERIALIZED (
        SELECT o.id AS old_id, n.id AS new_id
        FROM entity_feature_old_rows o FULL JOIN entity_feature_new_rows n USING (id)
        WHERE ROW(o."id", o."entity_feature_gate", o."workspace_id", o."organization_id", o."entity_feature_workspace_ids") IS DISTINCT FROM ROW(n."id", n."entity_feature_gate", n."workspace_id", n."organization_id", n."entity_feature_workspace_ids"))
      SELECT ARRAY(SELECT old_id FROM changed WHERE old_id IS NOT NULL
          UNION SELECT new_id FROM changed WHERE new_id IS NOT NULL),
        ARRAY(SELECT o.workspace_id FROM entity_feature_old_rows o
          UNION SELECT n.workspace_id FROM entity_feature_new_rows n)
        INTO changed_ids, changed_workspace_ids;
    ELSIF TG_OP = 'DELETE' THEN
      SELECT ARRAY(SELECT id FROM entity_feature_old_rows),
        ARRAY(SELECT DISTINCT o.workspace_id FROM entity_feature_old_rows o)
        INTO changed_ids, changed_workspace_ids;
    ELSE
      SELECT ARRAY(SELECT id FROM entity_feature_new_rows),
        ARRAY(SELECT DISTINCT n.workspace_id FROM entity_feature_new_rows n)
        INTO changed_ids, changed_workspace_ids;
    END IF;
    IF cardinality(changed_ids) = 0 THEN RETURN NULL; END IF;
    IF TG_OP <> 'INSERT' AND current_setting('transaction_isolation') <> 'read committed' THEN
      RAISE EXCEPTION 'Entity feature propagation requires a current snapshot'
        USING ERRCODE = '40001';
    END IF;
    SELECT ARRAY(SELECT candidates.child_name FROM (
        SELECT 'document_translation_units'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."document_translation_units" c WHERE (c."run_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids))))) candidates ORDER BY candidates.child_name)
      INTO matching_children;
    FOREACH child_name IN ARRAY matching_children LOOP
      IF child_name = 'document_translation_units' THEN
          UPDATE public."document_translation_units" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."run_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids)));
      ELSE
        RAISE EXCEPTION 'Unknown entity feature child %', child_name USING ERRCODE = 'XX000';
      END IF;
    END LOOP;
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME = 'folio_collab_rooms' THEN
    IF TG_OP = 'UPDATE' THEN
      WITH changed AS MATERIALIZED (
        SELECT o.id AS old_id, n.id AS new_id
        FROM entity_feature_old_rows o FULL JOIN entity_feature_new_rows n USING (id)
        WHERE ROW(o."id", o."entity_feature_gate", o."workspace_id") IS DISTINCT FROM ROW(n."id", n."entity_feature_gate", n."workspace_id"))
      SELECT ARRAY(SELECT old_id FROM changed WHERE old_id IS NOT NULL
          UNION SELECT new_id FROM changed WHERE new_id IS NOT NULL),
        ARRAY(SELECT o.workspace_id FROM entity_feature_old_rows o
          UNION SELECT n.workspace_id FROM entity_feature_new_rows n)
        INTO changed_ids, changed_workspace_ids;
    ELSIF TG_OP = 'DELETE' THEN
      SELECT ARRAY(SELECT id FROM entity_feature_old_rows),
        ARRAY(SELECT DISTINCT o.workspace_id FROM entity_feature_old_rows o)
        INTO changed_ids, changed_workspace_ids;
    ELSE
      SELECT ARRAY(SELECT id FROM entity_feature_new_rows),
        ARRAY(SELECT DISTINCT n.workspace_id FROM entity_feature_new_rows n)
        INTO changed_ids, changed_workspace_ids;
    END IF;
    IF cardinality(changed_ids) = 0 THEN RETURN NULL; END IF;
    IF TG_OP <> 'INSERT' AND current_setting('transaction_isolation') <> 'read committed' THEN
      RAISE EXCEPTION 'Entity feature propagation requires a current snapshot'
        USING ERRCODE = '40001';
    END IF;
    SELECT ARRAY(SELECT candidates.child_name FROM (
        SELECT 'folio_collab_contributions'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."folio_collab_contributions" c WHERE (c."room_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids))))
        UNION ALL
        SELECT 'folio_collab_publications'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."folio_collab_publications" c WHERE (c."room_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids))))
        UNION ALL
        SELECT 'folio_collab_room_tokens'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."folio_collab_room_tokens" c WHERE (c."room_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids))))) candidates ORDER BY candidates.child_name)
      INTO matching_children;
    FOREACH child_name IN ARRAY matching_children LOOP
      IF child_name = 'folio_collab_contributions' THEN
          UPDATE public."folio_collab_contributions" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."room_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids)));
      ELSIF child_name = 'folio_collab_publications' THEN
          UPDATE public."folio_collab_publications" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."room_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids)));
      ELSIF child_name = 'folio_collab_room_tokens' THEN
          UPDATE public."folio_collab_room_tokens" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."room_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids)));
      ELSE
        RAISE EXCEPTION 'Unknown entity feature child %', child_name USING ERRCODE = 'XX000';
      END IF;
    END LOOP;
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME = 'legal_list_verification_runs' THEN
    IF TG_OP = 'UPDATE' THEN
      WITH changed AS MATERIALIZED (
        SELECT o.id AS old_id, n.id AS new_id
        FROM entity_feature_old_rows o FULL JOIN entity_feature_new_rows n USING (id)
        WHERE ROW(o."id", o."entity_feature_gate", o."workspace_id", o."organization_id") IS DISTINCT FROM ROW(n."id", n."entity_feature_gate", n."workspace_id", n."organization_id"))
      SELECT ARRAY(SELECT old_id FROM changed WHERE old_id IS NOT NULL
          UNION SELECT new_id FROM changed WHERE new_id IS NOT NULL),
        ARRAY(SELECT o.workspace_id FROM entity_feature_old_rows o
          UNION SELECT n.workspace_id FROM entity_feature_new_rows n)
        INTO changed_ids, changed_workspace_ids;
    ELSIF TG_OP = 'DELETE' THEN
      SELECT ARRAY(SELECT id FROM entity_feature_old_rows),
        ARRAY(SELECT DISTINCT o.workspace_id FROM entity_feature_old_rows o)
        INTO changed_ids, changed_workspace_ids;
    ELSE
      SELECT ARRAY(SELECT id FROM entity_feature_new_rows),
        ARRAY(SELECT DISTINCT n.workspace_id FROM entity_feature_new_rows n)
        INTO changed_ids, changed_workspace_ids;
    END IF;
    IF cardinality(changed_ids) = 0 THEN RETURN NULL; END IF;
    IF TG_OP <> 'INSERT' AND current_setting('transaction_isolation') <> 'read committed' THEN
      RAISE EXCEPTION 'Entity feature propagation requires a current snapshot'
        USING ERRCODE = '40001';
    END IF;
    SELECT ARRAY(SELECT candidates.child_name FROM (
        SELECT 'legal_list_claims'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."legal_list_claims" c WHERE (c."run_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids))))
        UNION ALL
        SELECT 'legal_list_verification_blocks'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."legal_list_verification_blocks" c WHERE (c."run_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids))))
        UNION ALL
        SELECT 'legal_list_verification_read_receipts'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."legal_list_verification_read_receipts" c WHERE (c."run_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids))))) candidates ORDER BY candidates.child_name)
      INTO matching_children;
    FOREACH child_name IN ARRAY matching_children LOOP
      IF child_name = 'legal_list_claims' THEN
          UPDATE public."legal_list_claims" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."run_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids)));
      ELSIF child_name = 'legal_list_verification_blocks' THEN
          UPDATE public."legal_list_verification_blocks" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."run_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids)));
      ELSIF child_name = 'legal_list_verification_read_receipts' THEN
          UPDATE public."legal_list_verification_read_receipts" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."run_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids)));
      ELSE
        RAISE EXCEPTION 'Unknown entity feature child %', child_name USING ERRCODE = 'XX000';
      END IF;
    END LOOP;
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME = 'legal_list_claims' THEN
    IF TG_OP = 'UPDATE' THEN
      WITH changed AS MATERIALIZED (
        SELECT o.id AS old_id, n.id AS new_id
        FROM entity_feature_old_rows o FULL JOIN entity_feature_new_rows n USING (id)
        WHERE ROW(o."id", o."entity_feature_gate", o."workspace_id", o."entity_feature_organization_ids") IS DISTINCT FROM ROW(n."id", n."entity_feature_gate", n."workspace_id", n."entity_feature_organization_ids"))
      SELECT ARRAY(SELECT old_id FROM changed WHERE old_id IS NOT NULL
          UNION SELECT new_id FROM changed WHERE new_id IS NOT NULL),
        ARRAY(SELECT o.workspace_id FROM entity_feature_old_rows o
          UNION SELECT n.workspace_id FROM entity_feature_new_rows n)
        INTO changed_ids, changed_workspace_ids;
    ELSIF TG_OP = 'DELETE' THEN
      SELECT ARRAY(SELECT id FROM entity_feature_old_rows),
        ARRAY(SELECT DISTINCT o.workspace_id FROM entity_feature_old_rows o)
        INTO changed_ids, changed_workspace_ids;
    ELSE
      SELECT ARRAY(SELECT id FROM entity_feature_new_rows),
        ARRAY(SELECT DISTINCT n.workspace_id FROM entity_feature_new_rows n)
        INTO changed_ids, changed_workspace_ids;
    END IF;
    IF cardinality(changed_ids) = 0 THEN RETURN NULL; END IF;
    IF TG_OP <> 'INSERT' AND current_setting('transaction_isolation') <> 'read committed' THEN
      RAISE EXCEPTION 'Entity feature propagation requires a current snapshot'
        USING ERRCODE = '40001';
    END IF;
    SELECT ARRAY(SELECT candidates.child_name FROM (
        SELECT 'legal_list_claim_review_events'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."legal_list_claim_review_events" c WHERE (c."claim_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids))))) candidates ORDER BY candidates.child_name)
      INTO matching_children;
    FOREACH child_name IN ARRAY matching_children LOOP
      IF child_name = 'legal_list_claim_review_events' THEN
          UPDATE public."legal_list_claim_review_events" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."claim_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids)));
      ELSE
        RAISE EXCEPTION 'Unknown entity feature child %', child_name USING ERRCODE = 'XX000';
      END IF;
    END LOOP;
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME = 'legal_list_generation_candidates' THEN
    IF TG_OP = 'UPDATE' THEN
      WITH changed AS MATERIALIZED (
        SELECT o.id AS old_id, n.id AS new_id
        FROM entity_feature_old_rows o FULL JOIN entity_feature_new_rows n USING (id)
        WHERE ROW(o."id", o."entity_feature_gate", o."workspace_id", o."entity_feature_workspace_ids") IS DISTINCT FROM ROW(n."id", n."entity_feature_gate", n."workspace_id", n."entity_feature_workspace_ids"))
      SELECT ARRAY(SELECT old_id FROM changed WHERE old_id IS NOT NULL
          UNION SELECT new_id FROM changed WHERE new_id IS NOT NULL),
        ARRAY(SELECT o.workspace_id FROM entity_feature_old_rows o
          UNION SELECT n.workspace_id FROM entity_feature_new_rows n)
        INTO changed_ids, changed_workspace_ids;
    ELSIF TG_OP = 'DELETE' THEN
      SELECT ARRAY(SELECT id FROM entity_feature_old_rows),
        ARRAY(SELECT DISTINCT o.workspace_id FROM entity_feature_old_rows o)
        INTO changed_ids, changed_workspace_ids;
    ELSE
      SELECT ARRAY(SELECT id FROM entity_feature_new_rows),
        ARRAY(SELECT DISTINCT n.workspace_id FROM entity_feature_new_rows n)
        INTO changed_ids, changed_workspace_ids;
    END IF;
    IF cardinality(changed_ids) = 0 THEN RETURN NULL; END IF;
    IF TG_OP <> 'INSERT' AND current_setting('transaction_isolation') <> 'read committed' THEN
      RAISE EXCEPTION 'Entity feature propagation requires a current snapshot'
        USING ERRCODE = '40001';
    END IF;
    SELECT ARRAY(SELECT candidates.child_name FROM (
        SELECT 'legal_list_generation_candidate_sources'::text AS child_name WHERE EXISTS (
          SELECT 1 FROM public."legal_list_generation_candidate_sources" c WHERE (c."candidate_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids))))) candidates ORDER BY candidates.child_name)
      INTO matching_children;
    FOREACH child_name IN ARRAY matching_children LOOP
      IF child_name = 'legal_list_generation_candidate_sources' THEN
          UPDATE public."legal_list_generation_candidate_sources" c SET entity_feature_gate = c.entity_feature_gate
            WHERE (c."candidate_id" IN (SELECT unnest(changed_ids)) AND c.workspace_id IN (SELECT unnest(changed_workspace_ids)));
      ELSE
        RAISE EXCEPTION 'Unknown entity feature child %', child_name USING ERRCODE = 'XX000';
      END IF;
    END LOOP;
    RETURN NULL;
  END IF;
  RETURN NULL;
END
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.entity_feature_gate_propagate() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.entity_feature_gate_write() TO SESSION_USER;
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint
CREATE TRIGGER entity_feature_gate_write BEFORE INSERT OR UPDATE ON public."correspondence_sources" FOR EACH ROW EXECUTE FUNCTION public.entity_feature_gate_write();
--> statement-breakpoint
SET LOCAL ROLE stella_entity_gate;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.entity_feature_gate_write() FROM SESSION_USER;
--> statement-breakpoint
RESET ROLE;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM stella_entity_gate;
--> statement-breakpoint
-- stella-migration-safety: reviewed grant-privileges - Restore the existing prohibition on switching into the maintenance role.
GRANT stella_entity_gate TO CURRENT_USER WITH SET FALSE;
