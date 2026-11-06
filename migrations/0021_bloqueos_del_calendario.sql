CREATE TABLE "calendar_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"professional_id" uuid NOT NULL,
	"time_range" "tstzrange" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_blocks_time_range_valid" CHECK (not isempty("calendar_blocks"."time_range") and lower_inc("calendar_blocks"."time_range") and not upper_inc("calendar_blocks"."time_range")
      and not lower_inf("calendar_blocks"."time_range") and not upper_inf("calendar_blocks"."time_range"))
);
--> statement-breakpoint
ALTER TABLE "calendar_blocks" ADD CONSTRAINT "calendar_blocks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_blocks" ADD CONSTRAINT "calendar_blocks_professional_fk" FOREIGN KEY ("tenant_id","professional_id") REFERENCES "public"."professionals"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "calendar_blocks_professional_idx" ON "calendar_blocks" USING btree ("tenant_id","professional_id");