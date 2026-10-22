import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { loadCredential } from '../modules/tenants/credentials.js';
import { tenants } from '../modules/tenants/schema.js';
import { whatsAppCredentialSchema } from '../modules/whatsapp/client.js';
import { checkTemplates, metaTemplateSchema, type MetaTemplate } from '../modules/whatsapp/templates.js';
import { DEFAULT_GRAPH_API_VERSION, loadConfig } from '../shared/config.js';
import { createDatabase } from '../shared/db.js';
import { createLogger } from '../shared/logger.js';

/**
 * Verifica las plantillas de un negocio en Meta (8.1, H10): que existan, su estado de aprobación y
 * que el texto sea idéntico al del código. Solo lee. Uso: `pnpm whatsapp:templates <slug-del-negocio>`.
 *
 * El id de la cuenta de WhatsApp Business sale de WHATSAPP_BUSINESS_ACCOUNT_ID (en .env); el token,
 * el del negocio, cifrado en la base. En la fase 0 las plantillas de la dueña también están en esa
 * cuenta. Desde H15 la cuenta se guarda con el negocio.
 */
const config = loadConfig(process.env);
const logger = createLogger(config);
const slug = process.argv[2];
const input = z.object({ WHATSAPP_BUSINESS_ACCOUNT_ID: z.string().regex(/^\d+$/) }).safeParse(process.env);
const graphApiVersion = config.whatsapp?.graphApiVersion ?? DEFAULT_GRAPH_API_VERSION;

const page = z.object({
  data: z.array(metaTemplateSchema),
  paging: z.object({ next: z.url().optional() }).optional(),
});

async function fetchTemplates(accountId: string, accessToken: string): Promise<MetaTemplate[]> {
  const templates: MetaTemplate[] = [];
  let url: string | undefined =
    `https://graph.facebook.com/${graphApiVersion}/${accountId}/message_templates` +
    '?fields=name,status,category,language,components&limit=100';
  while (url) {
    const response = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
    const body: unknown = await response.json().catch(() => null);
    const parsed = page.safeParse(body);
    if (!response.ok || !parsed.success) throw new Error(`Meta respondió ${String(response.status)} al pedir las plantillas`);
    templates.push(...parsed.data.data);
    url = parsed.data.paging?.next;
  }
  return templates;
}

if (!slug || !input.success || !config.credentialsKey) {
  logger.error(
    'Uso: pnpm whatsapp:templates <slug-del-negocio>, con WHATSAPP_BUSINESS_ACCOUNT_ID y ' +
      'CREDENTIALS_ENCRYPTION_KEY definidas en .env',
  );
  process.exitCode = 1;
} else {
  const database = createDatabase(config.databaseUrl);
  try {
    const [tenant] = await database.db.select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, slug));
    const credential = tenant
      ? whatsAppCredentialSchema.safeParse(
          await loadCredential(database.db, config.credentialsKey, { tenantId: tenant.id, kind: 'whatsapp' }),
        )
      : null;
    if (!credential?.success) {
      logger.error({ tenant: slug }, 'No existe el negocio o no tiene WhatsApp conectado (pnpm whatsapp:connect)');
      process.exitCode = 1;
    } else {
      const report = checkTemplates(await fetchTemplates(input.data.WHATSAPP_BUSINESS_ACCOUNT_ID, credential.data.accessToken));
      for (const { name, status, problems } of report) {
        const ok = status === 'APPROVED' && problems.length === 0;
        (ok ? logger.info.bind(logger) : logger.warn.bind(logger))({ template: name, status, problems }, ok ? 'Plantilla lista' : 'Plantilla con algo para revisar');
      }
      const ready = report.filter((row) => row.status === 'APPROVED' && row.problems.length === 0).length;
      logger.info({ ready, total: report.length }, 'Plantillas verificadas');
      if (ready < report.length) process.exitCode = 1;
    }
  } catch (error) {
    logger.fatal({ err: error }, 'No se pudieron verificar las plantillas');
    process.exitCode = 1;
  } finally {
    await database.close();
  }
}
