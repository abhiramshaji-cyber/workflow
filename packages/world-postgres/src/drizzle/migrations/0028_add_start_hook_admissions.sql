-- Atomic `start({ hook })` admission: one immutable accept-or-reject decision
-- per candidate run, written in the transaction that creates an accepted run.
-- Rows older than a candidate's 24h window are deleted as admissions go.
--
-- Required even with start Hooks off: every Hook insert writes `claims_token`.
-- The column additions and the unique index take locks that queue every
-- other query on workflow_runs and workflow_hooks behind them, so give up
-- after 10 seconds (unless the session set its own `lock_timeout`) and leave
-- the migration unapplied and retryable rather than stall the World. The
-- setting lasts for the migrator's transaction.
DO $$
BEGIN
  IF current_setting('lock_timeout') = '0' THEN
    PERFORM set_config('lock_timeout', '10s', true);
  END IF;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workflow"."workflow_start_hook_admissions" (
	"run_id" varchar PRIMARY KEY NOT NULL,
	"token" varchar NOT NULL,
	"decision" varchar NOT NULL,
	"conflicting_run_id" varchar,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_start_hook_admissions_created_at_index" ON "workflow"."workflow_start_hook_admissions" USING btree ("created_at");
--> statement-breakpoint
-- The reservation a run was admitted with (without its metadata), echoed on
-- the run.
ALTER TABLE "workflow"."workflow_runs" ADD COLUMN IF NOT EXISTS "start_hook_cbor" bytea;
--> statement-breakpoint
-- A reservation is a placeholder row in workflow_hooks, so the token read
-- every Hook creation and lookup already does finds it. Rows that claim their
-- token are unique per token; rows written before this migration do not
-- claim it, so the index cannot fail on existing data.
ALTER TABLE "workflow"."workflow_hooks" ADD COLUMN IF NOT EXISTS "claims_token" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "workflow"."workflow_hooks" ADD COLUMN IF NOT EXISTS "is_start_reservation" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "workflow"."workflow_hooks" ADD COLUMN IF NOT EXISTS "adopted_at" timestamp with time zone;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workflow_hooks_token_claim_unique" ON "workflow"."workflow_hooks" USING btree ("token") WHERE "claims_token";
