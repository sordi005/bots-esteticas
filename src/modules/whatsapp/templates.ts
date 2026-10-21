import type { TemplateMessage } from './outgoing.js';

/**
 * Las plantillas de WhatsApp (8.1, H10). Las define el código: el texto tiene que ser idéntico al
 * aprobado en Meta (lo verifica `pnpm whatsapp:templates`), porque con él se muestra en el historial
 * lo que se envió. Al enviar solo viajan el nombre y las variables.
 *
 * Reglas de Meta: una variable no abre ni cierra el texto, ni van dos seguidas, y su valor no lleva
 * saltos de línea (`templateMessage` los limpia). Todas son de utilidad ("Servicio" en el panel).
 */
export const TEMPLATE_LANGUAGE = 'es_AR';

export interface TemplateDefinition {
  /** Para quién: la clienta (cuenta del negocio) o la dueña (cuenta del número de avisos, 8.2). */
  audience: 'customer' | 'owner';
  body: string;
  /** La imagen del encabezado se fija al enviar (el comprobante, 8.2). */
  header?: 'image';
  /** Títulos de los botones de respuesta rápida, en orden. */
  buttons?: readonly string[];
}

export const TEMPLATES = {
  recordatorio_turno: {
    audience: 'customer',
    body: 'Hola, te recordamos tu turno de {{servicio}} con {{profesional}} el {{fecha_hora}}. ¿Nos confirmás si venís?',
    buttons: ['Confirmo', 'Reprogramar', 'Cancelar'],
  },
  recordatorio_turno_corto: {
    audience: 'customer',
    body: 'Te esperamos hoy a las {{hora}} para tu turno de {{servicio}}. La dirección es {{direccion}}. ¡Hasta pronto!',
  },
  reserva_vencida: {
    audience: 'customer',
    body:
      'Tu reserva de {{servicio}} del {{fecha_hora}} se liberó porque no nos llegó la seña a tiempo. ' +
      'Si querés otro horario, respondé este mensaje y te ayudamos.',
  },
  sena_confirmada: {
    audience: 'customer',
    body: '¡Seña recibida! Tu turno de {{servicio}} con {{profesional}} del {{fecha_hora}} quedó confirmado. ¡Te esperamos!',
  },
  sena_rechazada: {
    audience: 'customer',
    body:
      'No pudimos verificar la transferencia de la seña, así que el turno del {{fecha_hora}} quedó sin reservar. ' +
      'Si ya la hiciste, una persona del equipo te escribe por acá.',
  },
  aviso_comprobante: {
    audience: 'owner',
    header: 'image',
    body: 'Comprobante de seña para verificar: {{clienta}} mandó la seña de {{monto}} para {{turno}}. ¿Llegó la transferencia?',
    buttons: ['Recibida', 'No llegó'],
  },
  aviso_derivacion: {
    audience: 'owner',
    body:
      'Derivación: {{clienta}} necesita que la atiendas. Motivo: {{motivo}}. Resumen: {{resumen}}. ' +
      'El asistente no le contesta hasta el {{hasta}}. Escribile desde tu WhatsApp Business y, cuando termines, ' +
      'tocá «Ya la atendí».',
    buttons: ['Ya la atendí'],
  },
  aviso_cancelacion: {
    audience: 'owner',
    body: 'Cancelación: {{clienta}} canceló su turno de {{turno}}. Seña: {{sena}}. El horario ya quedó libre.',
  },
  aviso_reprogramacion: {
    audience: 'owner',
    body:
      'Reprogramación: {{clienta}} pasó su turno de {{servicio}} con {{profesional}} del {{antes}} al {{despues}}. ' +
      'El horario anterior quedó libre.',
  },
} as const satisfies Record<string, TemplateDefinition>;

export type TemplateName = keyof typeof TEMPLATES;

/** Las variables de un texto: `'… {{servicio}} … {{fecha_hora}}'` → `'servicio' | 'fecha_hora'`. */
type VariablesOf<Text extends string> = Text extends `${string}{{${infer Name}}}${infer Rest}`
  ? Name | VariablesOf<Rest>
  : never;

export type TemplateParams<Name extends TemplateName> = Record<VariablesOf<(typeof TEMPLATES)[Name]['body']>, string>;

const VARIABLE = /\{\{([a-z_]+)\}\}/g;

/** Los nombres de las variables de una plantilla, en el orden del texto. */
export function templateVariables(name: TemplateName): string[] {
  return [...TEMPLATES[name].body.matchAll(VARIABLE)].flatMap((match) => (match[1] ? [match[1]] : []));
}

/** Meta rechaza saltos de línea, tabulaciones y más de cuatro espacios seguidos en una variable. */
function cleanParam(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * El mensaje de una plantilla, listo para enviar. Falla si las variables o los botones no son los
 * de la plantilla: un error del código, que se ve en los tests y no en producción.
 */
export function templateMessage<Name extends TemplateName>(
  name: Name,
  input: { params: TemplateParams<Name>; buttonPayloads?: string[] },
): TemplateMessage {
  const definition: TemplateDefinition = TEMPLATES[name];
  const expected = templateVariables(name);
  const given = Object.entries(input.params as Record<string, string>);

  const missing = expected.filter((variable) => !given.some(([key]) => key === variable));
  const extra = given.filter(([key]) => !expected.includes(key)).map(([key]) => key);
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `Variables de la plantilla ${name}: faltan [${missing.join(', ')}], sobran [${extra.join(', ')}]`,
    );
  }

  const params = Object.fromEntries(given.map(([key, value]) => [key, cleanParam(value)]));
  const empty = Object.entries(params).filter(([, value]) => value === '').map(([key]) => key);
  if (empty.length > 0) throw new Error(`Variables vacías en la plantilla ${name}: ${empty.join(', ')}`);

  const buttons = definition.buttons ?? [];
  const payloads = input.buttonPayloads ?? [];
  if (payloads.length !== buttons.length) {
    throw new Error(`La plantilla ${name} tiene ${String(buttons.length)} botones y llegaron ${String(payloads.length)} datos`);
  }

  return {
    type: 'template',
    name,
    language: TEMPLATE_LANGUAGE,
    params,
    ...(payloads.length > 0 ? { buttonPayloads: payloads } : {}),
  };
}

const isTemplateName = (name: string): name is TemplateName => Object.hasOwn(TEMPLATES, name);

/** Lo que dice una plantilla enviada, con sus botones. Null si el código no la conoce. */
export function renderTemplate(message: TemplateMessage): string | null {
  if (!isTemplateName(message.name)) return null;
  const definition: TemplateDefinition = TEMPLATES[message.name];
  const text = definition.body.replace(VARIABLE, (whole, variable: string) => message.params[variable] ?? whole);
  return definition.buttons ? `${text}\n[Botones: ${definition.buttons.join(' | ')}]` : text;
}
