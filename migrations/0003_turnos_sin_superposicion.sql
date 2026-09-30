-- Dos turnos que ocupan el horario no pueden superponerse para la misma profesional
-- (sección 6.6). Lo decide la base, no el código: si dos clientas eligen el mismo horario
-- al mismo tiempo, la segunda inserción falla con el error 23P01.
--
-- Los estados que ocupan el horario son los de `occupiesSchedule` en
-- src/modules/scheduling/appointment-state-machine.ts. El test
-- tests/integration/appointment-overlap.test.ts verifica que coincidan.
--
-- btree_gist permite comparar `professional_id` con `=` dentro de un índice GiST.
CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_no_overlap"
  EXCLUDE USING gist ("professional_id" WITH =, "time_range" WITH &&)
  WHERE ("status" IN ('PENDING_DEPOSIT', 'DEPOSIT_REVIEW', 'CONFIRMED'));
