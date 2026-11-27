ALTER TYPE "public"."job_kind" ADD VALUE 'check_alerts';--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "whatsapp_business_account_id" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "whatsapp_coexistence_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_whatsapp_business_account_id_unique" UNIQUE("whatsapp_business_account_id");