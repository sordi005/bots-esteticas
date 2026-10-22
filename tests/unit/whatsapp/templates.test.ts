import { describe, expect, it } from 'vitest';
import { toGraphPayload } from '../../../src/modules/whatsapp/outgoing.js';
import {
  TEMPLATE_LANGUAGE,
  TEMPLATES,
  checkTemplates,
  renderTemplate,
  templateMessage,
  templateVariables,
  type MetaTemplate,
  type TemplateDefinition,
  type TemplateName,
} from '../../../src/modules/whatsapp/templates.js';

describe('templateMessage: arma la plantilla con sus variables (8.1)', () => {
  it('con el nombre, el idioma y las variables con nombre', () => {
    const message = templateMessage('reserva_vencida', {
      params: { servicio: 'Esmaltado semipermanente', fecha_hora: 'viernes 9/10 10:00' },
    });

    expect(message).toEqual({
      type: 'template',
      name: 'reserva_vencida',
      language: TEMPLATE_LANGUAGE,
      params: { servicio: 'Esmaltado semipermanente', fecha_hora: 'viernes 9/10 10:00' },
    });
  });

  it('limpia lo que Meta rechaza en una variable: saltos de línea, tabulaciones y espacios de más', () => {
    const message = templateMessage('aviso_derivacion', {
      params: {
        clienta: '  Caro Pérez (+5492614000001) ',
        motivo: 'queja o reclamo',
        resumen: 'Se quejó del turno\n\nde ayer:\tla atendieron    tarde',
        hasta: 'viernes 9/10 22:00',
      },
      buttonPayloads: ['aviso:1:handoff_attended'],
    });

    expect(message.params).toMatchObject({
      clienta: 'Caro Pérez (+5492614000001)',
      resumen: 'Se quejó del turno de ayer: la atendieron tarde',
    });
    expect(() => toGraphPayload('+5492614000001', message)).not.toThrow();
  });

  it('lleva el dato de cada botón, en el orden de los botones', () => {
    const message = templateMessage('recordatorio_turno', {
      params: { servicio: 'Semi', profesional: 'Mica', fecha_hora: 'viernes 9/10 10:00' },
      buttonPayloads: ['recordatorio:1:confirmar', 'recordatorio:1:reprogramar', 'recordatorio:1:cancelar'],
    });

    expect(message.buttonPayloads).toEqual([
      'recordatorio:1:confirmar',
      'recordatorio:1:reprogramar',
      'recordatorio:1:cancelar',
    ]);
  });

  it('falla si falta una variable o sobra una: el texto aprobado en Meta no cambia', () => {
    const missing = { servicio: 'Semi' } as unknown as { servicio: string; fecha_hora: string };
    const extra = { servicio: 'Semi', fecha_hora: 'viernes 9/10 10:00', monto: '$5.400' };

    expect(() => templateMessage('reserva_vencida', { params: missing })).toThrow(/fecha_hora/);
    expect(() => templateMessage('reserva_vencida', { params: extra })).toThrow(/monto/);
  });

  it('falla si una variable queda vacía después de limpiarla', () => {
    expect(() =>
      templateMessage('reserva_vencida', { params: { servicio: ' \n ', fecha_hora: 'viernes 9/10 10:00' } }),
    ).toThrow(/servicio/);
  });

  it('falla si la cantidad de datos no coincide con la de botones', () => {
    const params = { servicio: 'Semi', profesional: 'Mica', fecha_hora: 'viernes 9/10 10:00' };

    expect(() => templateMessage('recordatorio_turno', { params, buttonPayloads: ['recordatorio:1:confirmar'] })).toThrow();
    expect(() => templateMessage('recordatorio_turno', { params })).toThrow();
    expect(() =>
      templateMessage('reserva_vencida', {
        params: { servicio: 'Semi', fecha_hora: 'viernes 9/10 10:00' },
        buttonPayloads: ['x'],
      }),
    ).toThrow();
  });
});

describe('renderTemplate: lo que se envió, como texto para el historial', () => {
  it('el texto con las variables reemplazadas y los botones', () => {
    const message = templateMessage('recordatorio_turno', {
      params: { servicio: 'Semi', profesional: 'Mica', fecha_hora: 'viernes 9/10 10:00' },
      buttonPayloads: ['a', 'b', 'c'],
    });

    expect(renderTemplate(message)).toBe(
      'Hola, te recordamos tu turno de Semi con Mica el viernes 9/10 10:00. ¿Nos confirmás si venís?\n' +
        '[Botones: Confirmo | Reprogramar | Cancelar]',
    );
  });

  it('sin botones, solo el texto', () => {
    const message = templateMessage('reserva_vencida', {
      params: { servicio: 'Semi', fecha_hora: 'viernes 9/10 10:00' },
    });

    expect(renderTemplate(message)).toBe(
      'Tu reserva de Semi del viernes 9/10 10:00 se liberó porque no nos llegó la seña a tiempo. ' +
        'Si querés otro horario, respondé este mensaje y te ayudamos.',
    );
  });

  it('una plantilla que el código no conoce no se muestra', () => {
    expect(renderTemplate({ type: 'template', name: 'hello_world', language: 'en_US', params: {} })).toBeNull();
  });
});

describe('el catálogo cumple las reglas de Meta', () => {
  const names = Object.keys(TEMPLATES) as TemplateName[];

  it.each(names)('%s: ninguna variable abre ni cierra el texto, ni van dos seguidas', (name) => {
    const { body } = TEMPLATES[name];

    expect(body).not.toMatch(/^\{\{/);
    expect(body).not.toMatch(/\}\}$/);
    expect(body).not.toMatch(/\}\}\s*\{\{/);
    expect(body.length).toBeLessThanOrEqual(1024);
    expect(templateVariables(name).length).toBeGreaterThan(0);
  });

  it.each(names)('%s: botones de hasta 25 caracteres, como mucho 10', (name) => {
    const definition: TemplateDefinition = TEMPLATES[name];
    const buttons = definition.buttons ?? [];

    expect(buttons.length).toBeLessThanOrEqual(10);
    for (const title of buttons) expect(title.length).toBeLessThanOrEqual(25);
  });
});

describe('checkTemplates: las plantillas de Meta contra las del código (pnpm whatsapp:templates)', () => {
  /** Una plantilla como la devuelve Meta, idéntica a la del código. */
  function fromMeta(name: TemplateName, overrides: Partial<MetaTemplate> = {}): MetaTemplate {
    const definition: TemplateDefinition = TEMPLATES[name];
    return {
      name,
      status: 'APPROVED',
      category: 'UTILITY',
      language: 'es_AR',
      components: [
        ...(definition.header ? [{ type: 'HEADER', format: 'IMAGE' }] : []),
        { type: 'BODY', text: definition.body },
        ...(definition.buttons
          ? [{ type: 'BUTTONS', buttons: definition.buttons.map((text) => ({ type: 'QUICK_REPLY', text })) }]
          : []),
      ],
      ...overrides,
    };
  }

  const all = () => (Object.keys(TEMPLATES) as TemplateName[]).map((name) => fromMeta(name));

  it('todas aprobadas e iguales: ningún problema', () => {
    const report = checkTemplates(all());

    expect(report).toHaveLength(Object.keys(TEMPLATES).length);
    expect(report.every((row) => row.status === 'APPROVED' && row.problems.length === 0)).toBe(true);
  });

  it('una que falta en Meta se marca como faltante', () => {
    const report = checkTemplates(all().filter((template) => template.name !== 'reserva_vencida'));

    expect(report.find((row) => row.name === 'reserva_vencida')).toEqual({ name: 'reserva_vencida', status: 'MISSING', problems: [] });
  });

  it('dice el estado que informa Meta (pendiente, rechazada, pausada)', () => {
    const report = checkTemplates([
      fromMeta('recordatorio_turno', { status: 'PENDING' }),
      fromMeta('sena_confirmada', { status: 'REJECTED' }),
    ]);

    expect(report.find((row) => row.name === 'recordatorio_turno')?.status).toBe('PENDING');
    expect(report.find((row) => row.name === 'sena_confirmada')?.status).toBe('REJECTED');
  });

  it('un texto distinto al del código es un problema: el historial mostraría otra cosa', () => {
    const report = checkTemplates([
      fromMeta('reserva_vencida', {
        components: [{ type: 'BODY', text: 'Tu reserva de {{servicio}} del {{fecha_hora}} venció. ¡Escribinos!' }],
      }),
    ]);

    expect(report.find((row) => row.name === 'reserva_vencida')?.problems).toEqual(['el texto no coincide con el del código']);
  });

  it('botones distintos, la imagen que falta y otra categoría también', () => {
    const report = checkTemplates([
      fromMeta('recordatorio_turno', {
        components: [
          { type: 'BODY', text: TEMPLATES.recordatorio_turno.body },
          { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Confirmo' }, { type: 'QUICK_REPLY', text: 'Cancelo' }] },
        ],
      }),
      fromMeta('aviso_comprobante', {
        category: 'MARKETING',
        components: [
          { type: 'BODY', text: TEMPLATES.aviso_comprobante.body },
          { type: 'BUTTONS', buttons: TEMPLATES.aviso_comprobante.buttons.map((text) => ({ type: 'QUICK_REPLY', text })) },
        ],
      }),
    ]);

    expect(report.find((row) => row.name === 'recordatorio_turno')?.problems).toEqual([
      'los botones no coinciden: Confirmo | Cancelo',
    ]);
    expect(report.find((row) => row.name === 'aviso_comprobante')?.problems).toEqual([
      'Meta la clasificó como MARKETING, no como utilidad',
      'le falta la imagen del encabezado',
    ]);
  });

  it('solo cuenta las del idioma del código', () => {
    const report = checkTemplates([fromMeta('reserva_vencida', { language: 'es' })]);

    expect(report.find((row) => row.name === 'reserva_vencida')?.status).toBe('MISSING');
  });
});
