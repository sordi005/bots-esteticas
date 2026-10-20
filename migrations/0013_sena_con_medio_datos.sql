-- 4.5 y decisión 23: la seña guarda el medio del negocio al reservar (desde H9). Antes de que la
-- columna sea obligatoria (migración siguiente), las señas anteriores toman el medio que tiene hoy
-- su negocio; sin configuración, transferencia, que es el valor por defecto.
UPDATE "deposits" SET "method" = coalesce(
  (SELECT "deposit_payment_options"::text::"payment_method" FROM "tenant_settings"
    WHERE "tenant_settings"."tenant_id" = "deposits"."tenant_id"),
  'transfer'
) WHERE "method" IS NULL;
