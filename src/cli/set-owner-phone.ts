import { eq } from 'drizzle-orm';
import { parseOwnerPhone } from '../modules/tenants/owner-phone.js';
import { tenants } from '../modules/tenants/schema.js';
import { loadConfig } from '../shared/config.js';
import { createDatabase } from '../shared/db.js';
import { createLogger } from '../shared/logger.js';

/**
 * Carga el teléfono de la dueña, al que le llegan los avisos (8.2). Uso:
 * `pnpm owner:phone <slug-del-negocio> <teléfono>`, con el teléfono como lo identifica WhatsApp
 * (+549… para un celular argentino, sin el 15). En la demo es el celular que hace de dueña.
 * Cuando exista el panel de administración (H15), esto se hace desde ahí.
 */
const config = loadConfig(process.env);
const logger = createLogger(config);
const [slug, rawPhone] = process.argv.slice(2);
const parsed = rawPhone ? parseOwnerPhone(rawPhone) : null;

if (!slug || !parsed) {
  logger.error('Uso: pnpm owner:phone <slug-del-negocio> <teléfono>, por ejemplo +5492615550000');
  process.exitCode = 1;
} else if (!parsed.ok) {
  logger.error(parsed.reason);
  process.exitCode = 1;
} else {
  const database = createDatabase(config.databaseUrl);
  try {
    const [tenant] = await database.db
      .update(tenants)
      .set({ ownerPhone: parsed.phone })
      .where(eq(tenants.slug, slug))
      .returning({ id: tenants.id });
    if (tenant) {
      logger.info({ tenant: slug }, 'Teléfono de la dueña cargado');
    } else {
      logger.error({ tenant: slug }, 'No existe un negocio con ese slug');
      process.exitCode = 1;
    }
  } catch (error) {
    logger.fatal({ err: error }, 'No se pudo cargar el teléfono de la dueña');
    process.exitCode = 1;
  } finally {
    await database.close();
  }
}
