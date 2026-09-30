CREATE TYPE "public"."appointment_event_kind" AS ENUM('status_change', 'rescheduled');--> statement-breakpoint
ALTER TABLE "appointment_events" DROP CONSTRAINT "appointment_events_status_changes";--> statement-breakpoint
ALTER TABLE "appointment_events" ADD COLUMN "kind" "appointment_event_kind" DEFAULT 'status_change' NOT NULL;--> statement-breakpoint
ALTER TABLE "appointment_events" ADD COLUMN "previous_time_range" "tstzrange";--> statement-breakpoint
ALTER TABLE "appointment_events" ADD CONSTRAINT "appointment_events_previous_time_range_valid" CHECK (not isempty("appointment_events"."previous_time_range") and lower_inc("appointment_events"."previous_time_range") and not upper_inc("appointment_events"."previous_time_range")
      and not lower_inf("appointment_events"."previous_time_range") and not upper_inf("appointment_events"."previous_time_range"));--> statement-breakpoint
ALTER TABLE "appointment_events" ADD CONSTRAINT "appointment_events_kind_consistent" CHECK (("appointment_events"."kind" = 'status_change'
          and "appointment_events"."from_status" is distinct from "appointment_events"."to_status"
          and "appointment_events"."previous_time_range" is null)
        or ("appointment_events"."kind" = 'rescheduled'
          and "appointment_events"."from_status" is not null
          and "appointment_events"."from_status" = "appointment_events"."to_status"
          and "appointment_events"."previous_time_range" is not null));