CREATE TYPE "public"."audit_action" AS ENUM('create', 'update', 'delete');--> statement-breakpoint
CREATE TYPE "public"."business_info_topic" AS ENUM('address', 'parking', 'payment_methods', 'promotions', 'policies', 'aftercare');--> statement-breakpoint
CREATE TYPE "public"."price_type" AS ENUM('fixed', 'from');--> statement-breakpoint
CREATE TYPE "public"."schedule_exception_kind" AS ENUM('closed', 'special_hours');--> statement-breakpoint
CREATE TYPE "public"."assistant_status" AS ENUM('active', 'paused');--> statement-breakpoint
CREATE TYPE "public"."handoff_reason" AS ENUM('customer_request', 'complaint', 'sensitive_topic', 'unsupported_media', 'requires_consultation', 'off_catalog', 'policy_exception', 'not_understood');--> statement-breakpoint
CREATE TYPE "public"."handoff_status" AS ENUM('open', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."message_direction" AS ENUM('inbound', 'outbound', 'echo');--> statement-breakpoint
CREATE TYPE "public"."deposit_status" AS ENUM('pending', 'in_review', 'approved', 'rejected', 'expired');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('mercadopago', 'transfer');--> statement-breakpoint
CREATE TYPE "public"."actor" AS ENUM('assistant', 'owner', 'system', 'admin');--> statement-breakpoint
CREATE TYPE "public"."appointment_status" AS ENUM('PENDING_DEPOSIT', 'DEPOSIT_REVIEW', 'CONFIRMED', 'DEPOSIT_REJECTED', 'EXPIRED', 'COMPLETED', 'NO_SHOW', 'CANCELLED_BY_CUSTOMER', 'CANCELLED_BY_BUSINESS');--> statement-breakpoint
CREATE TYPE "public"."credential_kind" AS ENUM('whatsapp', 'mercadopago', 'google');--> statement-breakpoint
CREATE TYPE "public"."deposit_payment_options" AS ENUM('mercadopago', 'transfer', 'both');--> statement-breakpoint
CREATE TYPE "public"."deposit_requirement" AS ENUM('never', 'always', 'new_customers', 'customers_with_no_shows');--> statement-breakpoint
CREATE TYPE "public"."emoji_usage" AS ENUM('none', 'low', 'medium');--> statement-breakpoint
CREATE TYPE "public"."tenant_plan" AS ENUM('basic', 'appointments', 'complete');--> statement-breakpoint
CREATE TYPE "public"."tenant_status" AS ENUM('active', 'paused', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."template_approval_status" AS ENUM('pending', 'approved', 'rejected', 'paused', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."template_category" AS ENUM('utility', 'marketing', 'authentication');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"actor" "actor" NOT NULL,
	"entity" text NOT NULL,
	"entity_id" uuid,
	"action" "audit_action" NOT NULL,
	"changes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "business_info" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"topic" "business_info_topic" NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "business_info_tenant_topic_key" UNIQUE("tenant_id","topic"),
	CONSTRAINT "business_info_content_not_blank" CHECK (btrim("business_info"."content") <> '')
);
--> statement-breakpoint
CREATE TABLE "holidays" (
	"date" date PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "professional_services" (
	"tenant_id" uuid NOT NULL,
	"professional_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"duration_override_minutes" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "professional_services_pkey" PRIMARY KEY("professional_id","service_id"),
	CONSTRAINT "professional_services_duration_override_positive" CHECK ("professional_services"."duration_override_minutes" > 0)
);
--> statement-breakpoint
CREATE TABLE "professionals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"google_calendar_id" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "professionals_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "schedule_exceptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"professional_id" uuid,
	"time_range" "tstzrange" NOT NULL,
	"kind" "schedule_exception_kind" NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schedule_exceptions_time_range_valid" CHECK (not isempty("schedule_exceptions"."time_range") and lower_inc("schedule_exceptions"."time_range") and not upper_inc("schedule_exceptions"."time_range")
      and not lower_inf("schedule_exceptions"."time_range") and not upper_inf("schedule_exceptions"."time_range"))
);
--> statement-breakpoint
CREATE TABLE "services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"aliases" text[] DEFAULT '{}' NOT NULL,
	"category" text NOT NULL,
	"duration_minutes" integer NOT NULL,
	"buffer_minutes" integer DEFAULT 0 NOT NULL,
	"price_cents" integer NOT NULL,
	"cash_price_cents" integer,
	"price_type" "price_type" DEFAULT 'fixed' NOT NULL,
	"deposit_requirement" "deposit_requirement",
	"deposit_percentage" integer,
	"deposit_fixed_amount_cents" integer,
	"requires_consultation" boolean DEFAULT false NOT NULL,
	"maintenance_interval_days" integer,
	"visible" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "services_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "services_tenant_name_key" UNIQUE("tenant_id","name"),
	CONSTRAINT "services_duration_positive" CHECK ("services"."duration_minutes" > 0),
	CONSTRAINT "services_buffer_non_negative" CHECK ("services"."buffer_minutes" >= 0),
	CONSTRAINT "services_price_non_negative" CHECK ("services"."price_cents" >= 0),
	CONSTRAINT "services_cash_price_non_negative" CHECK ("services"."cash_price_cents" >= 0),
	CONSTRAINT "services_deposit_single_amount" CHECK (num_nonnulls("services"."deposit_percentage", "services"."deposit_fixed_amount_cents") <= 1),
	CONSTRAINT "services_deposit_percentage_range" CHECK ("services"."deposit_percentage" between 1 and 100),
	CONSTRAINT "services_deposit_fixed_positive" CHECK ("services"."deposit_fixed_amount_cents" > 0),
	CONSTRAINT "services_maintenance_interval_positive" CHECK ("services"."maintenance_interval_days" > 0)
);
--> statement-breakpoint
CREATE TABLE "working_hours" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"professional_id" uuid NOT NULL,
	"weekday" smallint NOT NULL,
	"start_time" time NOT NULL,
	"end_time" time NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "working_hours_weekday_iso" CHECK ("working_hours"."weekday" between 1 and 7),
	CONSTRAINT "working_hours_start_before_end" CHECK ("working_hours"."start_time" < "working_hours"."end_time")
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"assistant_status" "assistant_status" DEFAULT 'active' NOT NULL,
	"paused_until" timestamp with time zone,
	"last_message_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversations_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "conversations_tenant_customer_key" UNIQUE("tenant_id","customer_id"),
	CONSTRAINT "conversations_active_not_paused" CHECK ("conversations"."assistant_status" = 'paused' or "conversations"."paused_until" is null)
);
--> statement-breakpoint
CREATE TABLE "handoffs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"reason" "handoff_reason" NOT NULL,
	"summary" text NOT NULL,
	"status" "handoff_status" DEFAULT 'open' NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "handoffs_resolved_at_matches_status" CHECK (("handoffs"."status" = 'resolved') = ("handoffs"."resolved_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"direction" "message_direction" NOT NULL,
	"type" text NOT NULL,
	"content" jsonb NOT NULL,
	"whatsapp_message_id" text,
	"pricing_category" text,
	"estimated_cost_usd" numeric(10, 4),
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_whatsapp_message_id_unique" UNIQUE("whatsapp_message_id"),
	CONSTRAINT "messages_received_have_whatsapp_id" CHECK ("messages"."direction" = 'outbound' or "messages"."whatsapp_message_id" is not null),
	CONSTRAINT "messages_cost_non_negative" CHECK ("messages"."estimated_cost_usd" >= 0)
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"phone" text NOT NULL,
	"whatsapp_profile_name" text,
	"name" text,
	"preferred_professional_id" uuid,
	"no_show_count" integer DEFAULT 0 NOT NULL,
	"marketing_consent_at" timestamp with time zone,
	"origin" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customers_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "customers_tenant_phone_key" UNIQUE("tenant_id","phone"),
	CONSTRAINT "customers_phone_e164" CHECK ("customers"."phone" ~ '^\+[1-9][0-9]{7,14}$'),
	CONSTRAINT "customers_no_show_count_non_negative" CHECK ("customers"."no_show_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "deposits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"appointment_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	"method" "payment_method",
	"status" "deposit_status" DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"mercadopago_preference_id" text,
	"mercadopago_payment_id" text,
	"receipt_media_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deposits_mercadopago_payment_id_unique" UNIQUE("mercadopago_payment_id"),
	CONSTRAINT "deposits_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "deposits_tenant_appointment_key" UNIQUE("tenant_id","appointment_id"),
	CONSTRAINT "deposits_amount_positive" CHECK ("deposits"."amount_cents" > 0),
	CONSTRAINT "deposits_review_has_receipt" CHECK ("deposits"."status" <> 'in_review' or "deposits"."receipt_media_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "appointment_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"appointment_id" uuid NOT NULL,
	"from_status" "appointment_status",
	"to_status" "appointment_status" NOT NULL,
	"actor" "actor" NOT NULL,
	"reason" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appointment_events_status_changes" CHECK ("appointment_events"."from_status" is distinct from "appointment_events"."to_status")
);
--> statement-breakpoint
CREATE TABLE "appointments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"professional_id" uuid NOT NULL,
	"time_range" "tstzrange" NOT NULL,
	"duration_minutes" integer NOT NULL,
	"buffer_minutes" integer NOT NULL,
	"price_cents" integer NOT NULL,
	"cash_price_cents" integer,
	"price_type" "price_type" NOT NULL,
	"status" "appointment_status" NOT NULL,
	"origin" "actor" NOT NULL,
	"calendar_event_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appointments_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "appointments_time_range_valid" CHECK (not isempty("appointments"."time_range") and lower_inc("appointments"."time_range") and not upper_inc("appointments"."time_range")
      and not lower_inf("appointments"."time_range") and not upper_inf("appointments"."time_range")),
	CONSTRAINT "appointments_time_range_matches_duration" CHECK (upper("appointments"."time_range") - lower("appointments"."time_range")
        = make_interval(mins => "appointments"."duration_minutes" + "appointments"."buffer_minutes")),
	CONSTRAINT "appointments_duration_positive" CHECK ("appointments"."duration_minutes" > 0),
	CONSTRAINT "appointments_buffer_non_negative" CHECK ("appointments"."buffer_minutes" >= 0),
	CONSTRAINT "appointments_price_non_negative" CHECK ("appointments"."price_cents" >= 0),
	CONSTRAINT "appointments_cash_price_non_negative" CHECK ("appointments"."cash_price_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "tenant_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" "credential_kind" NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"iv" "bytea" NOT NULL,
	"auth_tag" "bytea" NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_credentials_tenant_kind_key" UNIQUE("tenant_id","kind"),
	CONSTRAINT "tenant_credentials_iv_length" CHECK (octet_length("tenant_credentials"."iv") = 12),
	CONSTRAINT "tenant_credentials_auth_tag_length" CHECK (octet_length("tenant_credentials"."auth_tag") = 16)
);
--> statement-breakpoint
CREATE TABLE "tenant_settings" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"deposit_requirement" "deposit_requirement" DEFAULT 'always' NOT NULL,
	"deposit_percentage" integer DEFAULT 30,
	"deposit_fixed_amount_cents" integer,
	"deposit_payment_window_minutes" integer DEFAULT 60 NOT NULL,
	"deposit_payment_options" "deposit_payment_options" DEFAULT 'both' NOT NULL,
	"transfer_alias" text,
	"transfer_cbu" text,
	"transfer_account_holder" text,
	"free_cancellation_notice_hours" integer DEFAULT 24 NOT NULL,
	"reschedules_keeping_deposit" integer DEFAULT 1 NOT NULL,
	"slot_granularity_minutes" integer DEFAULT 15 NOT NULL,
	"min_booking_notice_minutes" integer DEFAULT 120 NOT NULL,
	"max_booking_advance_days" integer DEFAULT 30 NOT NULL,
	"slots_offered" integer DEFAULT 3 NOT NULL,
	"works_on_holidays" boolean DEFAULT false NOT NULL,
	"human_attention_hours" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reminder_window_start" time DEFAULT '09:00' NOT NULL,
	"reminder_window_end" time DEFAULT '21:00' NOT NULL,
	"short_reminder_enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_settings_deposit_single_amount" CHECK (num_nonnulls("tenant_settings"."deposit_percentage", "tenant_settings"."deposit_fixed_amount_cents") = 1),
	CONSTRAINT "tenant_settings_deposit_percentage_range" CHECK ("tenant_settings"."deposit_percentage" between 1 and 100),
	CONSTRAINT "tenant_settings_deposit_fixed_positive" CHECK ("tenant_settings"."deposit_fixed_amount_cents" > 0),
	CONSTRAINT "tenant_settings_payment_window_positive" CHECK ("tenant_settings"."deposit_payment_window_minutes" > 0),
	CONSTRAINT "tenant_settings_transfer_cbu_format" CHECK ("tenant_settings"."transfer_cbu" ~ '^[0-9]{22}$'),
	CONSTRAINT "tenant_settings_cancellation_notice" CHECK ("tenant_settings"."free_cancellation_notice_hours" >= 0),
	CONSTRAINT "tenant_settings_reschedules" CHECK ("tenant_settings"."reschedules_keeping_deposit" >= 0),
	CONSTRAINT "tenant_settings_slot_granularity" CHECK ("tenant_settings"."slot_granularity_minutes" between 5 and 60),
	CONSTRAINT "tenant_settings_min_booking_notice" CHECK ("tenant_settings"."min_booking_notice_minutes" >= 0),
	CONSTRAINT "tenant_settings_max_booking_advance" CHECK ("tenant_settings"."max_booking_advance_days" > 0),
	CONSTRAINT "tenant_settings_slots_offered" CHECK ("tenant_settings"."slots_offered" between 1 and 10),
	CONSTRAINT "tenant_settings_reminder_window" CHECK ("tenant_settings"."reminder_window_start" < "tenant_settings"."reminder_window_end")
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"timezone" text DEFAULT 'America/Argentina/Mendoza' NOT NULL,
	"status" "tenant_status" DEFAULT 'active' NOT NULL,
	"plan" "tenant_plan" NOT NULL,
	"assistant_name" text NOT NULL,
	"emoji_usage" "emoji_usage" DEFAULT 'low' NOT NULL,
	"uses_voseo" boolean DEFAULT true NOT NULL,
	"whatsapp_phone_number_id" text,
	"owner_phone" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_slug_unique" UNIQUE("slug"),
	CONSTRAINT "tenants_whatsapp_phone_number_id_unique" UNIQUE("whatsapp_phone_number_id"),
	CONSTRAINT "tenants_slug_format" CHECK ("tenants"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
	CONSTRAINT "tenants_owner_phone_e164" CHECK ("tenants"."owner_phone" ~ '^\+[1-9][0-9]{7,14}$')
);
--> statement-breakpoint
CREATE TABLE "message_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"meta_name" text NOT NULL,
	"category" "template_category" NOT NULL,
	"language" text DEFAULT 'es_AR' NOT NULL,
	"approval_status" "template_approval_status" DEFAULT 'pending' NOT NULL,
	"variables" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_templates_tenant_name_language_key" UNIQUE("tenant_id","meta_name","language")
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_info" ADD CONSTRAINT "business_info_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "professional_services" ADD CONSTRAINT "professional_services_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "professional_services" ADD CONSTRAINT "professional_services_professional_fk" FOREIGN KEY ("tenant_id","professional_id") REFERENCES "public"."professionals"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "professional_services" ADD CONSTRAINT "professional_services_service_fk" FOREIGN KEY ("tenant_id","service_id") REFERENCES "public"."services"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "professionals" ADD CONSTRAINT "professionals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_exceptions" ADD CONSTRAINT "schedule_exceptions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_exceptions" ADD CONSTRAINT "schedule_exceptions_professional_fk" FOREIGN KEY ("tenant_id","professional_id") REFERENCES "public"."professionals"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "working_hours" ADD CONSTRAINT "working_hours_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "working_hours" ADD CONSTRAINT "working_hours_professional_fk" FOREIGN KEY ("tenant_id","professional_id") REFERENCES "public"."professionals"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_conversation_fk" FOREIGN KEY ("tenant_id","conversation_id") REFERENCES "public"."conversations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_fk" FOREIGN KEY ("tenant_id","conversation_id") REFERENCES "public"."conversations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_preferred_professional_fk" FOREIGN KEY ("tenant_id","preferred_professional_id") REFERENCES "public"."professionals"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_appointment_fk" FOREIGN KEY ("tenant_id","appointment_id") REFERENCES "public"."appointments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_events" ADD CONSTRAINT "appointment_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_events" ADD CONSTRAINT "appointment_events_appointment_fk" FOREIGN KEY ("tenant_id","appointment_id") REFERENCES "public"."appointments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_service_fk" FOREIGN KEY ("tenant_id","service_id") REFERENCES "public"."services"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_professional_fk" FOREIGN KEY ("tenant_id","professional_id") REFERENCES "public"."professionals"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_credentials" ADD CONSTRAINT "tenant_credentials_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD CONSTRAINT "tenant_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_tenant_idx" ON "audit_log" USING btree ("tenant_id","occurred_at");--> statement-breakpoint
CREATE INDEX "professional_services_service_idx" ON "professional_services" USING btree ("tenant_id","service_id");--> statement-breakpoint
CREATE INDEX "schedule_exceptions_tenant_idx" ON "schedule_exceptions" USING btree ("tenant_id","professional_id");--> statement-breakpoint
CREATE INDEX "working_hours_professional_idx" ON "working_hours" USING btree ("tenant_id","professional_id");--> statement-breakpoint
CREATE INDEX "handoffs_status_idx" ON "handoffs" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "messages_conversation_idx" ON "messages" USING btree ("tenant_id","conversation_id","occurred_at");--> statement-breakpoint
CREATE INDEX "appointment_events_appointment_idx" ON "appointment_events" USING btree ("tenant_id","appointment_id","occurred_at");--> statement-breakpoint
CREATE INDEX "appointments_customer_idx" ON "appointments" USING btree ("tenant_id","customer_id");--> statement-breakpoint
CREATE INDEX "appointments_professional_idx" ON "appointments" USING btree ("tenant_id","professional_id");--> statement-breakpoint
CREATE INDEX "appointments_status_idx" ON "appointments" USING btree ("tenant_id","status");