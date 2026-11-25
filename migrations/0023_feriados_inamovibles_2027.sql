-- Feriados nacionales inamovibles 2027.
-- Fuente: Ley 27.399, art. 1 (Boletín Oficial 18/10/2017),
-- https://www.argentina.gob.ar/normativa/nacional/ley-27399-281835/texto, consultada el 24/11/2026.
-- Carnaval (lunes y martes) y Viernes Santo dependen de la Pascua: 28/03/2027.
--
-- La lista oficial de 2027 todavía no está publicada en https://www.argentina.gob.ar/feriados
-- (al 24/11/2026 ofrece solo 2025 y 2026). Los inamovibles se cargan igual porque los fija la
-- ley y solo el Congreso puede moverlos (sección 4.2 de la especificación).
--
-- No se cargan los trasladables (17/6 Güemes, 17/8 San Martín, 12/10 Diversidad Cultural y
-- 20/11 Soberanía Nacional): su fecha efectiva la puede fijar el Poder Ejecutivo (art. 6 de la
-- Ley 27.399 y Decreto 614/2025). Entran en otra migración con la lista oficial. Tampoco se
-- cargan los días no laborables (Jueves Santo, puentes turísticos), igual que en 2026.
INSERT INTO "holidays" ("date", "name") VALUES
  ('2027-01-01', 'Año Nuevo'),
  ('2027-02-08', 'Carnaval'),
  ('2027-02-09', 'Carnaval'),
  ('2027-03-24', 'Día Nacional de la Memoria por la Verdad y la Justicia'),
  ('2027-03-26', 'Viernes Santo'),
  ('2027-04-02', 'Día del Veterano y de los Caídos en la Guerra de Malvinas'),
  ('2027-05-01', 'Día del Trabajador'),
  ('2027-05-25', 'Día de la Revolución de Mayo'),
  ('2027-06-20', 'Paso a la Inmortalidad del Gral. Manuel Belgrano'),
  ('2027-07-09', 'Día de la Independencia'),
  ('2027-12-08', 'Inmaculada Concepción de María'),
  ('2027-12-25', 'Navidad')
ON CONFLICT ("date") DO UPDATE SET "name" = EXCLUDED."name";
