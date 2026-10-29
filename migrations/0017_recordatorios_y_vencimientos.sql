ALTER TYPE "public"."job_kind" ADD VALUE 'send_appointment_reminder';--> statement-breakpoint
ALTER TYPE "public"."job_kind" ADD VALUE 'expire_reservation';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'appointment_reminder';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'appointment_short_reminder';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'reservation_expired';--> statement-breakpoint
ALTER TYPE "public"."appointment_event_kind" ADD VALUE 'attendance_confirmed';--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_recipient_matches_kind";--> statement-breakpoint
ALTER TABLE "appointment_events" DROP CONSTRAINT "appointment_events_kind_consistent";--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "template" jsonb;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "appointment_start" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_once_per_appointment_key" ON "notifications" USING btree ("tenant_id","appointment_id","kind","appointment_start") WHERE "notifications"."appointment_start" is not null;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_once_per_appointment_has_start" CHECK (("notifications"."kind"::text in ('appointment_reminder', 'appointment_short_reminder', 'reservation_expired')) = ("notifications"."appointment_start" is not null)
        and ("notifications"."appointment_start" is null or "notifications"."appointment_id" is not null));--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_matches_kind" CHECK (("notifications"."recipient" = 'customer') = ("notifications"."kind"::text in ('deposit_confirmed', 'deposit_rejected', 'appointment_reminder', 'appointment_short_reminder', 'reservation_expired')));--> statement-breakpoint
ALTER TABLE "appointment_events" ADD CONSTRAINT "appointment_events_kind_consistent" CHECK (("appointment_events"."kind" = 'status_change'
          and "appointment_events"."from_status" is distinct from "appointment_events"."to_status"
          and "appointment_events"."previous_time_range" is null)
        or ("appointment_events"."kind" = 'rescheduled'
          and "appointment_events"."from_status" is not null
          and "appointment_events"."from_status" = "appointment_events"."to_status"
          and "appointment_events"."previous_time_range" is not null)
        or ("appointment_events"."kind"::text = 'attendance_confirmed'
          and "appointment_events"."from_status" is not null
          and "appointment_events"."from_status" = "appointment_events"."to_status"
          and "appointment_events"."previous_time_range" is null));