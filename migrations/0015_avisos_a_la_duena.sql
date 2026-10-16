CREATE TYPE "public"."notification_kind" AS ENUM('deposit_receipt', 'handoff', 'appointment_cancelled', 'appointment_rescheduled', 'owner_reply_ack', 'deposit_confirmed', 'deposit_rejected');--> statement-breakpoint
CREATE TYPE "public"."notification_recipient" AS ENUM('owner', 'customer');--> statement-breakpoint
CREATE TYPE "public"."notification_status" AS ENUM('pending', 'sent', 'failed');--> statement-breakpoint
CREATE TYPE "public"."owner_reply_action" AS ENUM('deposit_received', 'deposit_not_received', 'handoff_attended');--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"recipient" "notification_recipient" NOT NULL,
	"kind" "notification_kind" NOT NULL,
	"customer_id" uuid NOT NULL,
	"appointment_id" uuid,
	"deposit_id" uuid,
	"handoff_id" uuid,
	"message" jsonb NOT NULL,
	"receipt_media_id" text,
	"status" "notification_status" DEFAULT 'pending' NOT NULL,
	"whatsapp_message_id" text,
	"sent_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_whatsapp_message_id_unique" UNIQUE("whatsapp_message_id"),
	CONSTRAINT "notifications_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "notifications_sent_has_message_id" CHECK (("notifications"."status" = 'sent') = ("notifications"."sent_at" is not null)
        and ("notifications"."status" = 'sent') = ("notifications"."whatsapp_message_id" is not null)),
	CONSTRAINT "notifications_receipt_has_deposit" CHECK ("notifications"."kind" <> 'deposit_receipt' or ("notifications"."deposit_id" is not null and "notifications"."receipt_media_id" is not null)),
	CONSTRAINT "notifications_handoff_has_handoff" CHECK ("notifications"."kind" <> 'handoff' or "notifications"."handoff_id" is not null),
	CONSTRAINT "notifications_recipient_matches_kind" CHECK (("notifications"."recipient" = 'customer') = ("notifications"."kind" in ('deposit_confirmed', 'deposit_rejected')))
);
--> statement-breakpoint
CREATE TABLE "owner_replies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"notification_id" uuid NOT NULL,
	"action" "owner_reply_action" NOT NULL,
	"whatsapp_message_id" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "owner_replies_whatsapp_message_id_unique" UNIQUE("whatsapp_message_id")
);
--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_appointment_fk" FOREIGN KEY ("tenant_id","appointment_id") REFERENCES "public"."appointments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_deposit_fk" FOREIGN KEY ("tenant_id","deposit_id") REFERENCES "public"."deposits"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_handoff_fk" FOREIGN KEY ("tenant_id","handoff_id") REFERENCES "public"."handoffs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_replies" ADD CONSTRAINT "owner_replies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_replies" ADD CONSTRAINT "owner_replies_notification_fk" FOREIGN KEY ("tenant_id","notification_id") REFERENCES "public"."notifications"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notifications_deposit_idx" ON "notifications" USING btree ("tenant_id","deposit_id","kind");