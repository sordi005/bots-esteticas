ALTER TYPE "public"."handoff_reason" ADD VALUE 'payment_issue';--> statement-breakpoint
ALTER TYPE "public"."job_kind" ADD VALUE 'send_notification';--> statement-breakpoint
ALTER TYPE "public"."job_kind" ADD VALUE 'process_owner_reply';--> statement-breakpoint
ALTER TYPE "public"."job_kind" ADD VALUE 'remind_deposit_receipt';--> statement-breakpoint
ALTER TABLE "deposits" ALTER COLUMN "method" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_tenant_id_id_key" UNIQUE("tenant_id","id");