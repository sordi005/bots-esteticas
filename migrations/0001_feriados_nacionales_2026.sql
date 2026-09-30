-- Feriados nacionales 2026: inamovibles y trasladables, en su fecha efectiva.
-- Fuente: https://www.argentina.gob.ar/feriados (Jefatura de Gabinete de Ministros),
-- consultada el 30/09/2026. Ley 27.399, Decreto 614/2025 y Decreto 1103/2026.
--
-- No se cargan los días no laborables (puentes turísticos del 23/3, 10/7 y 7/12, días
-- religiosos, feriados solo regionales): para el sector privado son optativos. Un negocio
-- que cierra esos días lo carga como excepción de cierre.
INSERT INTO "holidays" ("date", "name") VALUES
  ('2026-01-01', 'Año Nuevo'),
  ('2026-02-16', 'Carnaval'),
  ('2026-02-17', 'Carnaval'),
  ('2026-03-24', 'Día Nacional de la Memoria por la Verdad y la Justicia'),
  ('2026-04-02', 'Día del Veterano y de los Caídos en la Guerra de Malvinas'),
  ('2026-04-03', 'Viernes Santo'),
  ('2026-05-01', 'Día del Trabajador'),
  ('2026-05-25', 'Día de la Revolución de Mayo'),
  ('2026-06-15', 'Paso a la Inmortalidad del Gral. Martín Miguel de Güemes (trasladado del 17/6)'),
  ('2026-06-20', 'Paso a la Inmortalidad del Gral. Manuel Belgrano'),
  ('2026-07-09', 'Día de la Independencia'),
  ('2026-08-17', 'Paso a la Inmortalidad del Gral. José de San Martín'),
  ('2026-10-12', 'Día de la Raza'),
  ('2026-11-09', 'Visita de Su Santidad el Papa León XIV'),
  ('2026-11-23', 'Día de la Soberanía Nacional (trasladado del 20/11)'),
  ('2026-12-08', 'Inmaculada Concepción de María'),
  ('2026-12-25', 'Navidad')
ON CONFLICT ("date") DO UPDATE SET "name" = EXCLUDED."name";
