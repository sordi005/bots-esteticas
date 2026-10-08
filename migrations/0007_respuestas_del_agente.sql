CREATE TYPE "public"."agent_outcome" AS ENUM('replied', 'tool_limit', 'fallback_refusal', 'fallback_max_tokens', 'fallback_invalid_output', 'rate_limited');--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"model" text,
	"llm_calls" integer DEFAULT 0 NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"tool_calls" text[] DEFAULT '{}' NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"outcome" "agent_outcome" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_runs_usage_non_negative" CHECK ("agent_runs"."input_tokens" >= 0 and "agent_runs"."output_tokens" >= 0 and "agent_runs"."cache_read_tokens" >= 0 and "agent_runs"."cache_write_tokens" >= 0),
	CONSTRAINT "agent_runs_calls_and_latency_non_negative" CHECK ("agent_runs"."llm_calls" >= 0 and "agent_runs"."latency_ms" >= 0),
	CONSTRAINT "agent_runs_model_matches_calls" CHECK (("agent_runs"."llm_calls" = 0) = ("agent_runs"."model" is null))
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_conversation_fk" FOREIGN KEY ("tenant_id","conversation_id") REFERENCES "public"."conversations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_runs_conversation_idx" ON "agent_runs" USING btree ("tenant_id","conversation_id","created_at");