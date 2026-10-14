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
  bookingName: null,
  preferredProfessionalName: null,
  humanReplyWhen: 'en este horario',
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

  it('si no tiene nombre para el turno cargado, le dice al modelo que lo pida antes de reservar', () => {
    // El nombre de perfil de WhatsApp solo sirve de saludo: crear_reserva exige el nombre para el turno.
    const context = buildTurnContext({ ...base, customerName: 'Caro (perfil)', bookingName: null });

    expect(context).toMatch(/Nombre para el turno: no está cargado.*pedíselo antes de reservar/);
  });

  it('con el nombre para el turno cargado, lo dice y no hace falta pedirlo', () => {
    const context = buildTurnContext({ ...base, customerName: 'Caro Pérez', bookingName: 'Caro Pérez' });

    expect(context).toMatch(/Nombre para el turno: Caro Pérez \(ya está cargado: no lo pidas\)/);
    expect(context).not.toMatch(/pedíselo/);
  });

  it.each(['en este horario', 'el viernes 9/10 a las 9:00', 'lo antes posible'])(
    'dice cuándo le responde una persona si deriva (%s), calculado por el código, para que el modelo lo escriba',
    (when) => {
      const context = buildTurnContext({ ...base, humanReplyWhen: when });

      expect(context).toContain(`- Si derivás a una persona, le responde ${when}: escribilo tal cual en tu mensaje`);
    },
  );

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

const APPOINTMENT = '00000000-0000-4000-8000-000000000301';

const appointment = (tipo: 'turno' | 'cancelar') =>
  ({
    tipo,
    turnoId: APPOINTMENT,
    servicioId: 'srv-1',
    profesionalId: 'pro-1',
    servicioNombre: 'Esmaltado semipermanente',
    profesionalNombre: 'Mica',
    texto: 'martes 13/10 17:00',
    estado: 'confirmado',
    ocupaHorario: true,
  }) as const satisfies ResolvedChoice;

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

  it('un horario que sigue libre, con su id para reservarlo', () => {
    const text = describeChoice(slot, MENDOZA);

    expect(text).toBe(
      'Eligió el horario lunes 5/10 9:00 con Mica para Esmaltado semipermanente (60 min), ' +
        'horario_id=horario:srv-1:pro-1:2026-10-05T12:00:00.000Z; sigue libre.',
    );
  });

  it('un horario que ya no está libre', () => {
    const text = describeChoice({ ...slot, sigueLibre: false }, MENDOZA);

    expect(text).toBe(
      'Eligió el horario lunes 5/10 9:00 con Mica para Esmaltado semipermanente (60 min), ' +
        'horario_id=horario:srv-1:pro-1:2026-10-05T12:00:00.000Z; ya no está libre.',
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

  it('un turno elegido: sus datos y su id para cancelarlo o reprogramarlo (con el turno_id, sin servicio ni profesional)', () => {
    const text = describeChoice(appointment('turno'), MENDOZA);

    expect(text).toBe(
      'Eligió su turno del martes 13/10 17:00 (Esmaltado semipermanente con Mica, confirmado), ' +
        `turno_id=turno:${APPOINTMENT}: ` +
        'seguí con lo que venía pidiendo (cancelar o reprogramar ese turno; para reprogramar, consultá los ' +
        'horarios con consultar_horarios_para_reprogramar y ese turno_id).',
    );
  });

  it('"Sí, cancelar": confirmó cancelar ese turno, así que se cancela con confirmada=true', () => {
    const text = describeChoice(appointment('cancelar'), MENDOZA);

    expect(text).toBe(
      'Confirmó que quiere cancelar el turno del martes 13/10 17:00 (Esmaltado semipermanente con Mica, confirmado), ' +
        `turno_id=turno:${APPOINTMENT}: llamá a cancelar_turno con confirmada=true.`,
    );
  });

  it('"Sí, cancelar" sobre un turno que ya no ocupa horario lo avisa y deja que la herramienta responda', () => {
    const text = describeChoice({ ...appointment('cancelar'), estado: 'cancelado', ocupaHorario: false }, MENDOZA);

    expect(text).toContain('ese turno ya no está activo (cancelado)');
    expect(text).toContain(`turno_id=turno:${APPOINTMENT}`);
    expect(text).toContain('cancelar_turno');
  });

  it('un turno elegido que ya no ocupa horario lo avisa', () => {
    const text = describeChoice({ ...appointment('turno'), estado: 'vencido por falta de seña', ocupaHorario: false }, MENDOZA);

    expect(text).toContain('ese turno ya no está activo (vencido por falta de seña)');
  });

  describe('un horario para reprogramar un turno (decisión 28)', () => {
    const reschedule = {
      tipo: 'reprogramar',
      turnoId: APPOINTMENT,
      servicioId: 'srv-1',
      profesionalId: 'pro-1',
      servicioNombre: 'Esmaltado semipermanente',
      profesionalNombre: 'Mica',
      turnoTexto: 'martes 13/10 17:00',
      estado: 'confirmado',
      ocupaHorario: true,
      inicio: '2026-10-14T18:30:00.000Z',
      texto: 'miércoles 14/10 15:30',
      duracionMinutos: 60,
      sigueLibre: true,
    } as const satisfies ResolvedChoice;
    const slotId = `reprogramar:${APPOINTMENT}:2026-10-14T18:30:00.000Z`;

    it('si sigue libre: el turno que se mueve, el horario nuevo, su horario_id y que elegirlo ya es la confirmación', () => {
      expect(describeChoice(reschedule, MENDOZA)).toBe(
        'Eligió el horario miércoles 14/10 15:30 para pasar su turno del martes 13/10 17:00 ' +
          `(Esmaltado semipermanente con Mica), horario_id=${slotId}; sigue libre. ` +
          'Elegirlo ya es la confirmación: llamá a reprogramar_turno con ese horario_id.',
      );
    });

    it('si ya no está libre: no reprograma, vuelve a consultar con el turno_id', () => {
      const text = describeChoice({ ...reschedule, sigueLibre: false }, MENDOZA);

      expect(text).toContain(`horario_id=${slotId}; ya no está libre`);
      expect(text).toContain(
        `volvé a consultar los horarios con consultar_horarios_para_reprogramar y turno_id=turno:${APPOINTMENT}`,
      );
      expect(text).not.toContain('consultar_disponibilidad');
      expect(text).not.toContain('llamá a reprogramar_turno');
    });

    it('si el turno ya no ocupa horario, lo avisa', () => {
      const text = describeChoice({ ...reschedule, estado: 'cancelado', ocupaHorario: false, sigueLibre: false }, MENDOZA);

      expect(text).toContain('Ojo: ese turno ya no está activo (cancelado)');
    });

    it('nunca dice horario_id=horario:… ni sugiere crear_reserva: es para reprogramar', () => {
      const text = describeChoice(reschedule, MENDOZA);

      expect(text).not.toContain('horario:');
      expect(text).not.toContain('crear_reserva');
    });
  });

  it('"ver más horarios" de una reprogramación: sigue con el turno_id, no con el servicio', () => {
    const text = describeChoice(
      {
        tipo: 'ver_mas_reprogramar',
        turnoId: APPOINTMENT,
        turnoTexto: 'martes 13/10 17:00',
        ocupaHorario: true,
        despuesDe: '2026-10-05T18:00:00.000Z',
      },
      MENDOZA,
    );

    expect(text).toBe(
      'Pidió ver otros horarios para pasar su turno del martes 13/10 17:00, después de lunes 5/10 15:00: ' +
        `consultá los horarios con consultar_horarios_para_reprogramar, turno_id=turno:${APPOINTMENT} y despues_de=2026-10-05T18:00:00.000Z.`,
    );
    expect(text).not.toContain('servicio_id');
    expect(text).not.toContain('consultar_disponibilidad');
  });

  it('una opción que ya no es válida', () => {
    expect(describeChoice({ tipo: 'desconocido' }, MENDOZA)).toBe(
      'Eligió una opción que ya no es válida (puede ser de una conversación vieja).',
    );
  });
});
