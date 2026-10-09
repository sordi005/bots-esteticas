import { describe, expect, it } from 'vitest';
import { buildTurnContext, describeChoice } from '../../../../src/modules/conversation/agent/turn-context.js';
import type { ResolvedChoice } from '../../../../src/modules/conversation/tools/index.js';

const MENDOZA = 'America/Argentina/Mendoza';
// 12:00 UTC es 9:00 en Mendoza (UTC-3, sin horario de verano).
const MONDAY_9 = new Date('2026-10-05T12:00:00.000Z');

const base = {
  now: MONDAY_9,
  timeZone: MENDOZA,
  isNewConversation: false,
  customerName: null,
  preferredProfessionalName: null,
  choices: [] as ResolvedChoice[],
};

describe('buildTurnContext: lo que cambia en cada vuelta, fuera del prompt del sistema', () => {
  it('lleva la fecha y la hora locales del negocio, escritas por el código, y la zona horaria', () => {
    const context = buildTurnContext(base);

    expect(context).toContain('lunes 5/10/2026 9:00');
    expect(context).toContain('2026-10-05');
    expect(context).toContain(MENDOZA);
  });

  it('convierte bien cerca de la medianoche: 02:30 UTC todavía es el día anterior en Mendoza', () => {
    const context = buildTurnContext({ ...base, now: new Date('2026-10-06T02:30:00.000Z') });

    expect(context).toContain('lunes 5/10/2026 23:30');
    expect(context).toContain('2026-10-05');
  });

  it('avisa si la conversación es nueva y si no', () => {
    expect(buildTurnContext({ ...base, isNewConversation: true })).toMatch(/Conversación nueva: sí/);
    expect(buildTurnContext({ ...base, isNewConversation: false })).toMatch(/Conversación nueva: no/);
  });

  it('lleva el nombre de la clienta y su profesional preferida si se conocen', () => {
    const context = buildTurnContext({ ...base, customerName: 'Caro', preferredProfessionalName: 'Mica' });

    expect(context).toMatch(/Nombre de la clienta: Caro/);
    expect(context).toMatch(/Profesional preferida: Mica/);
  });

  it('si no conoce el nombre, no lo inventa ni deja un hueco', () => {
    const context = buildTurnContext(base);

    expect(context).toMatch(/Nombre de la clienta: no se conoce/);
    expect(context).not.toMatch(/Profesional preferida/);
  });

  it('empieza marcando que no lo escribió la clienta', () => {
    expect(buildTurnContext(base)).toMatch(/^Contexto del sistema \(no lo escribió la clienta\)/);
  });

  it('describe las elecciones de la clienta ya resueltas, numeradas', () => {
    const context = buildTurnContext({
      ...base,
      choices: [{ tipo: 'desconocido' }, { tipo: 'desconocido' }],
    });

    expect(context).toMatch(/Elecciones de la clienta en este mensaje:/);
    expect(context).toMatch(/1\. .*ya no es válida/);
    expect(context).toMatch(/2\. .*ya no es válida/);
  });

  it('sin elecciones no menciona el tema', () => {
    expect(buildTurnContext(base)).not.toMatch(/Elecciones/);
  });
});

describe('describeChoice: la elección resuelta como texto, nunca el título del botón (5.3)', () => {
  const slot = {
    tipo: 'horario',
    servicioId: 'srv-1',
    servicioNombre: 'Esmaltado semipermanente',
    profesionalId: 'pro-1',
    profesionalNombre: 'Mica',
    inicio: '2026-10-05T12:00:00.000Z',
    texto: 'lunes 5/10 9:00',
    duracionMinutos: 60,
    sigueLibre: true,
  } as const satisfies ResolvedChoice;

  it('un servicio: nombre, precio y duración escritos, y su id para consultar horarios', () => {
    const text = describeChoice(
      {
        tipo: 'servicio',
        servicioId: 'srv-1',
        nombre: 'Esmaltado semipermanente',
        precioTexto: '$18.000',
        duracionTexto: '60 min',
        requiereConsultaPrevia: false,
      },
      MENDOZA,
    );

    expect(text).toContain('Esmaltado semipermanente');
    expect(text).toContain('$18.000');
    expect(text).toContain('60 min');
    expect(text).toContain('servicio_id=srv-1');
    expect(text).not.toMatch(/consulta previa/);
  });

  it('un servicio que requiere consulta previa lo dice', () => {
    const text = describeChoice(
      {
        tipo: 'servicio',
        servicioId: 'srv-2',
        nombre: 'Depilación láser',
        precioTexto: 'desde $25.000',
        duracionTexto: '45 min',
        requiereConsultaPrevia: true,
      },
      MENDOZA,
    );

    expect(text).toMatch(/requiere consulta previa/i);
  });

  it('un horario que sigue libre', () => {
    const text = describeChoice(slot, MENDOZA);

    expect(text).toBe(
      'Eligió el horario lunes 5/10 9:00 con Mica para Esmaltado semipermanente (60 min); sigue libre.',
    );
  });

  it('un horario que ya no está libre', () => {
    const text = describeChoice({ ...slot, sigueLibre: false }, MENDOZA);

    expect(text).toBe(
      'Eligió el horario lunes 5/10 9:00 con Mica para Esmaltado semipermanente (60 min); ya no está libre.',
    );
  });

  it('"ver más horarios": con los datos para volver a consultar después del último ofrecido', () => {
    const text = describeChoice(
      { tipo: 'ver_mas', servicioId: 'srv-1', profesionalId: 'pro-1', despuesDe: '2026-10-05T18:00:00.000Z' },
      MENDOZA,
    );

    expect(text).toContain('otros horarios');
    expect(text).toContain('lunes 5/10 15:00');
    expect(text).toContain('servicio_id=srv-1');
    expect(text).toContain('profesional_id=pro-1');
    expect(text).toContain('despues_de=2026-10-05T18:00:00.000Z');
  });

  it('"ver más horarios" sin profesional pedida no menciona profesional_id', () => {
    const text = describeChoice(
      { tipo: 'ver_mas', servicioId: 'srv-1', profesionalId: null, despuesDe: '2026-10-05T18:00:00.000Z' },
      MENDOZA,
    );

    expect(text).not.toContain('profesional_id');
  });

  it('una opción que ya no es válida', () => {
    expect(describeChoice({ tipo: 'desconocido' }, MENDOZA)).toBe(
      'Eligió una opción que ya no es válida (puede ser de una conversación vieja).',
    );
  });
});
