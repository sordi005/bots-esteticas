-- Decisión 23: el negocio elige un solo medio para la seña. Antes de sacar el valor "both" del
-- enum (migración siguiente), los negocios que lo tenían pasan a transferencia, que es el medio
-- que funciona hasta que llegue Mercado Pago (H11).
UPDATE "tenant_settings" SET "deposit_payment_options" = 'transfer' WHERE "deposit_payment_options" = 'both';
