ALTER TABLE "tenant_settings" ALTER COLUMN "deposit_payment_options" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "tenant_settings" ALTER COLUMN "deposit_payment_options" SET DEFAULT 'transfer'::text;--> statement-breakpoint
DROP TYPE "public"."deposit_payment_options";--> statement-breakpoint
CREATE TYPE "public"."deposit_payment_options" AS ENUM('mercadopago', 'transfer');--> statement-breakpoint
ALTER TABLE "tenant_settings" ALTER COLUMN "deposit_payment_options" SET DEFAULT 'transfer'::"public"."deposit_payment_options";--> statement-breakpoint
ALTER TABLE "tenant_settings" ALTER COLUMN "deposit_payment_options" SET DATA TYPE "public"."deposit_payment_options" USING "deposit_payment_options"::"public"."deposit_payment_options";