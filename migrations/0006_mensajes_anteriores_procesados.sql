-- Los mensajes recibidos antes de que existiera el worker (H6) se dan por procesados.
-- Sin esto, la primera vuelta de cada conversación juntaría mensajes viejos con el nuevo.
UPDATE "messages" SET "processed_at" = "created_at"
WHERE "direction" = 'inbound' AND "processed_at" IS NULL;
