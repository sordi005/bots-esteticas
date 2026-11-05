import { createGoogleCalendarClient } from '../modules/calendar/client.js';
import { connectProfessionalCalendar } from '../modules/calendar/connection.js';
import { createAccessTokenSource } from '../modules/calendar/google-auth.js';
import { loadConfig } from '../shared/config.js';
import { createDatabase } from '../shared/db.js';
import { createLogger } from '../shared/logger.js';

/**
 * Conecta el Google Calendar de una profesional (8.4). Uso:
 * `pnpm calendar:connect <slug-del-negocio> <profesional> <calendario>`, donde el calendario es la
 * dirección de Gmail de la profesional. Antes, ella lo comparte con el mail de la cuenta de servicio
 * con "Hacer cambios en eventos". Cuando exista el panel de administración (H15), esto se hace desde ahí.
 */
const config = loadConfig(process.env);
const logger = createLogger(config);
const [slug, professionalName, calendarId] = process.argv.slice(2);

const MESSAGES = {
  tenant_not_found: 'No existe un negocio con ese slug',
  professional_not_found: 'Ese negocio no tiene una profesional con ese nombre',
  not_shared: 'Google no encuentra ese calendario: falta compartirlo con la cuenta de servicio, o el mail está mal',
  read_only: 'El calendario está compartido sin permiso para escribir: tiene que ser "Hacer cambios en eventos"',
} as const;

if (!slug || !professionalName || !calendarId || !config.googleServiceAccount) {
  logger.error(
    'Uso: pnpm calendar:connect <slug-del-negocio> <profesional> <calendario>, con GOOGLE_SERVICE_ACCOUNT_KEY en .env',
  );
  process.exitCode = 1;
} else {
  const { clientEmail } = config.googleServiceAccount;
  const tokens = createAccessTokenSource({
    serviceAccount: config.googleServiceAccount,
    scope: 'https://www.googleapis.com/auth/calendar.events',
    now: () => new Date(),
  });
  const database = createDatabase(config.databaseUrl);
  try {
    const result = await connectProfessionalCalendar(
      { db: database.db, logger, now: () => new Date(), client: createGoogleCalendarClient({ tokens }) },
      { tenantSlug: slug, professionalName, calendarId },
    );
    if (result.status === 'connected') {
      logger.info({ tenant: slug, professional: professionalName }, 'Calendario conectado: los bloqueos se copian en un momento');
    } else {
      logger.error({ tenant: slug, professional: professionalName, serviceAccount: clientEmail }, MESSAGES[result.status]);
      process.exitCode = 1;
    }
  } catch (error) {
    logger.fatal({ err: error }, 'No se pudo conectar el calendario');
    process.exitCode = 1;
  } finally {
    await database.close();
  }
}
