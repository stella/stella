SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- Every reference to a contact carries the referencing row's organization:
--
--   (organization_id, <contact column>) -> contacts (organization_id, id)
--
-- A foreign key is checked without row security, so a reference by contact id
-- alone names a contact whatever its organization. With the organization in
-- the key, a contact of another organization has no matching key.
--
-- The referenced side is contacts_org_id_unique, the UNIQUE (organization_id,
-- id) constraint attached in 20261003122800. ON DELETE matches each existing
-- id-only reference, so deleting a contact behaves as before: relationships,
-- matter links and the search projection cascade; a matter's client
-- restricts. Writers already supply the contact's own organization
-- (apps/api/src/handlers/workspaces/contacts/create.ts,
-- apps/api/src/lib/search/index-global.ts).
--
-- NOT VALID here: the ADD writes catalog rows without scanning and enforces
-- new and updated rows at once. 20261022120100 validates existing rows in its
-- own transaction under SHARE UPDATE EXCLUSIVE; 20261022120200 then drops the
-- id-only references these replace. Each statement is one line because squawk
-- anchors a suppression to the line directly above the statement it reports.

ALTER TABLE "contact_relationships" ADD CONSTRAINT "contact_relationships_person_fk" FOREIGN KEY ("organization_id", "person_id") REFERENCES "contacts" ("organization_id", "id") ON DELETE CASCADE NOT VALID;--> statement-breakpoint

ALTER TABLE "contact_relationships" ADD CONSTRAINT "contact_relationships_related_contact_fk" FOREIGN KEY ("organization_id", "related_contact_id") REFERENCES "contacts" ("organization_id", "id") ON DELETE CASCADE NOT VALID;--> statement-breakpoint

ALTER TABLE "contact_search_documents" ADD CONSTRAINT "contact_search_documents_contact_fk" FOREIGN KEY ("organization_id", "contact_id") REFERENCES "contacts" ("organization_id", "id") ON DELETE CASCADE NOT VALID;--> statement-breakpoint

ALTER TABLE "workspace_contacts" ADD CONSTRAINT "workspace_contacts_contact_fk" FOREIGN KEY ("organization_id", "contact_id") REFERENCES "contacts" ("organization_id", "id") ON DELETE CASCADE NOT VALID;--> statement-breakpoint

ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_client_fk" FOREIGN KEY ("organization_id", "client_id") REFERENCES "contacts" ("organization_id", "id") ON DELETE RESTRICT NOT VALID;
