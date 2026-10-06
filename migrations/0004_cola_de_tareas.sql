CREATE TYPE "public"."job_kind" AS ENUM('process_conversation');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('pending', 'running', 'done', 'failed');--> statement-breakpoint
CREATE TABLE "scheduled_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" "job_kind" NOT NULL,
	"key" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "job_status" DEFAULT 'pending' NOT NULL,
	"run_at" timestamp with time zone NOT NULL,
	"rerun_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"locked_until" timestamp with time zone,
	"lock_token" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scheduled_jobs_tenant_kind_key_key" UNIQUE("tenant_id","kind","key"),
	CONSTRAINT "scheduled_jobs_lock_matches_status" CHECK (("scheduled_jobs"."status" = 'running') = ("scheduled_jobs"."locked_until" is not null)
        and ("scheduled_jobs"."status" = 'running') = ("scheduled_jobs"."lock_token" is not null)),
	CONSTRAINT "scheduled_jobs_rerun_only_while_running" CHECK ("scheduled_jobs"."status" = 'running' or "scheduled_jobs"."rerun_at" is null),
	CONSTRAINT "scheduled_jobs_attempts_non_negative" CHECK ("scheduled_jobs"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "scheduled_jobs" ADD CONSTRAINT "scheduled_jobs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scheduled_jobs_due_idx" ON "scheduled_jobs" USING btree ("run_at") WHERE "scheduled_jobs"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "scheduled_jobs_lease_idx" ON "scheduled_jobs" USING btree ("locked_until") WHERE "scheduled_jobs"."status" = 'running';