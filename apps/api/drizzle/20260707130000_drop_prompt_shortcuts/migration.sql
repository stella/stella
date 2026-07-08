-- stella-migration-safety: reviewed destructive-change - prompt shortcuts were copied into agent_skills by 20260602120000_agent_skills_command_autoinvoke; rollback is a forward restore from backup or from the migrated agent_skills rows.
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint
DROP TABLE IF EXISTS "prompt_shortcuts";
