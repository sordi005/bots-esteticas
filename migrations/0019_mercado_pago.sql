ALTER TYPE "public"."job_kind" ADD VALUE 'process_mercadopago_payment';--> statement-breakpoint
ALTER TYPE "public"."job_kind" ADD VALUE 'refresh_mercadopago_token';--> statement-breakpoint
ALTER TABLE "deposits" ADD COLUMN "mercadopago_payment_url" text;--> statement-breakpoint
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_mercadopago_link_complete" CHECK (("deposits"."mercadopago_preference_id" is null) = ("deposits"."mercadopago_payment_url" is null));