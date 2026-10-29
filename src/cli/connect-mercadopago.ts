import { eq } from 'drizzle-orm';
import { connectionLink, OAUTH_STATE_TTL_MS } from '../modules/mercadopago/oauth.js';
import { tenants } from '../modules/tenants/schema.js';
import { loadConfig } from '../shared/config.js';
import { createDatabase } from '../shared/db.js';
import { createLogger } from '../shared/logger.js';

/**
 * Imprime el link para que la dueña conecte su cuenta de Mercado Pago (8.3). Uso:
 * `pnpm mercadopago:connect <slug-del-negocio>`. El link vence a los 15 minutos; al autorizar,
 * Mercado Pago vuelve a `/mercadopago/oauth/callback`, que guarda los tokens cifrados. Para eso el
 * servidor tiene que estar corriendo y llegar desde `PUBLIC_BASE_URL` (en desarrollo, el túnel).
 * Cuando exista el panel de administración (H15), esto se hace desde ahí.
 */
const config = loadConfig(process.env);
const logger = createLogger(config);
const slug = process.argv[2];

if (!slug || !config.mercadoPago) {
  logger.error(
    'Uso: pnpm mercadopago:connect <slug-del-negocio>, con MERCADOPAGO_CLIENT_ID, MERCADOPAGO_CLIENT_SECRET, ' +
      'MERCADOPAGO_WEBHOOK_SECRET y PUBLIC_BASE_URL definidas en .env',
  );
  process.exitCode = 1;
} else {
  const database = createDatabase(config.databaseUrl);
  try {
    const [tenant] = await database.db.select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, slug));
    if (tenant) {
      const link = connectionLink({ tenantId: tenant.id, now: new Date(), app: config.mercadoPago });
      // El link no es un secreto (el state vence y solo sirve con la cuenta de la dueña), pero va a la
      // terminal y no al log: es para copiarlo.
      process.stdout.write(
        `\nLink para conectar Mercado Pago (vence en ${String(OAUTH_STATE_TTL_MS / 60_000)} minutos):\n\n${link}\n\n`,
      );
    } else {
      logger.error({ tenant: slug }, 'No existe un negocio con ese slug');
      process.exitCode = 1;
    }
  } catch (error) {
    logger.fatal({ err: error }, 'No se pudo armar el link de Mercado Pago');
    process.exitCode = 1;
  } finally {
    await database.close();
  }
}
