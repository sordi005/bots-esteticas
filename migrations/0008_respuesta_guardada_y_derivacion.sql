ALTER TYPE "public"."agent_outcome" ADD VALUE 'handoff_not_understood';--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "pending_reply" jsonb;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "pending_reply_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_pending_reply_pair" CHECK (("conversations"."pending_reply" is null) = ("conversations"."pending_reply_at" is null));