import { describe, expect, it } from 'vitest';
import {
  appointmentReminder,
  cancellationNotice,
  cancellationTemplate,
  customerDepositConfirmed,
  customerDepositConfirmedTemplate,
  customerDepositRejected,
  customerDepositRejectedTemplate,
  depositReceiptNotice,
  depositReceiptTemplate,
  depositReviewAck,
  handoffAttendedAck,
  handoffNotice,
  handoffTemplate,
  reservationExpired,
  reservationExpiredTemplate,
  rescheduleNotice,
  rescheduleTemplate,
  shortAppointmentReminder,
  type NoticeAppointment,
} from '../../../src/modules/notifications/texts.js';
import { renderTemplate } from '../../../src/modules/whatsapp/templates.js';
import { freeFormMessageSchema, type FreeFormMessage } from '../../../src/modules/whatsapp/outgoing.js';
import { localDateTimeToInstant } from '../../../src/shared/time-zone.js';

/**
 * Los textos de los avisos los escribe el código (8.2): fechas y montos en la zona del negocio,
 * nunca datos de salud, y siempre dentro de los límites de Meta.
 */

const ZONE = 'America/Argentina/Mendoza';
const NOTICE = '0b5c1d2e-3f40-4a51-8b62-7c83d94ea5f6';

const appointment: NoticeAppointment = {
  customerName: 'Caro Pérez',
  customerPhone: '+5492614000001',
  serviceName: 'Esmaltado semipermanente',
  professionalName: 'Mica',
  start: localDateTimeToInstant('2026-10-05', '10:00', ZONE),
  timeZone: ZONE,
};

function bodyOf(message: FreeFormMessage): string {
  expect(freeFormMessageSchema.safeParse(message).success).toBe(true);
  return message.body;
}

describe('aviso del comprobante a la dueña (4.5)', () => {
  it('dice quién, qué turno y cuánto, y ofrece "Recibida" / "No llegó"', () => {
    const message = depositReceiptNotice({ notificationId: NOTICE, appointment, amountCents: 540_000, reminder: 0 });

    expect(message.type).toBe('buttons');
    const body = bodyOf(message);
    expect(body).toContain('Caro Pérez (+5492614000001)');
    expect(body).toContain('$5.400');
    expect(body).toContain('Esmaltado semipermanente con Mica, lunes 5/10 10:00');
    expect(body).not.toMatch(/recordatorio/i);
    expect(message.buttons).toEqual([
      { id: `aviso:${NOTICE}:recibida`, title: 'Recibida' },
      { id: `aviso:${NOTICE}:no_llego`, title: 'No llegó' },
    ]);
  });

  it('un recordatorio lo dice al principio', () => {
    const body = bodyOf(depositReceiptNotice({ notificationId: NOTICE, appointment, amountCents: 540_000, reminder: 2 }));

    expect(body).toMatch(/^\*Recordatorio\*/);
  });
});

describe('aviso de una derivación (4.8)', () => {
  const pausedUntil = localDateTimeToInstant('2026-10-04', '21:00', ZONE);

  it('dice quién, el motivo, el resumen y hasta cuándo está pausado, con "Ya la atendí"', () => {
    const message = handoffNotice({
      notificationId: NOTICE,
      appointment: { customerName: 'Caro Pérez', customerPhone: '+5492614000001', timeZone: ZONE },
      reason: 'complaint',
      summary: 'Se queja porque le cobraron de más',
      pausedUntil,
    });

    const body = bodyOf(message);
    expect(body).toContain('Caro Pérez (+5492614000001)');
    expect(body).toContain('queja');
    expect(body).toContain('Se queja porque le cobraron de más');
    expect(body).toContain('domingo 4/10 21:00');
    expect(message.buttons).toEqual([
      { id: `aviso:${NOTICE}:atendida`, title: 'Ya la atendí' },
    ]);
  });

  it('un problema con la seña se nombra como tal', () => {
    const body = bodyOf(
      handoffNotice({
        notificationId: NOTICE,
        appointment: { customerName: 'Caro Pérez', customerPhone: '+5492614000001', timeZone: ZONE },
        reason: 'payment_issue',
        summary: 'Mandó un comprobante con dos señas pendientes',
        pausedUntil,
      }),
    );

    expect(body).toContain('un problema con la seña');
  });
});

describe('avisos de cancelación y reprogramación (4.6)', () => {
  it('una cancelación con la seña pagada recuerda que la devolución la decide ella', () => {
    const message = cancellationNotice({ appointment, deposit: { status: 'approved', amountCents: 540_000 } });

    expect(message.type).toBe('text');
    expect(message.body).toContain('Caro Pérez canceló su turno');
    expect(message.body).toContain('lunes 5/10 10:00');
    expect(message.body).toContain('$5.400');
    expect(message.body).toMatch(/devolución/);
  });

  it('con la seña en verificación, también', () => {
    const message = cancellationNotice({ appointment, deposit: { status: 'in_review', amountCents: 540_000 } });

    expect(message.body).toMatch(/verificación/);
    expect(message.body).toMatch(/devolución/);
  });

  it('con la seña sin pagar no habla de devoluciones', () => {
    const message = cancellationNotice({ appointment, deposit: { status: 'pending', amountCents: 540_000 } });

    expect(message.body).not.toMatch(/devolución|\$5\.400/);
  });

  it('una reprogramación dice el horario anterior y el nuevo', () => {
    const message = rescheduleNotice({
      appointment: { ...appointment, start: localDateTimeToInstant('2026-10-05', '16:00', ZONE) },
      previousStart: appointment.start,
    });

    expect(message.body).toContain('del lunes 5/10 10:00 al lunes 5/10 16:00');
  });
});

describe('respuestas a la dueña después de tocar un botón', () => {
  it('confirmar o rechazar dice qué se le avisó a la clienta', () => {
    expect(depositReviewAck({ appointment, outcome: 'CONFIRMED' }).body).toContain(
      'le avisé a Caro Pérez que su turno del lunes 5/10 10:00 quedó confirmado',
    );
    const rejected = depositReviewAck({ appointment, outcome: 'DEPOSIT_REJECTED' }).body;
    expect(rejected).toContain('quedó sin reservar');
    expect(rejected).toMatch(/pausa/);
  });

  it.each([
    ['CONFIRMED', 'ya estaba confirmado'],
    ['DEPOSIT_REJECTED', 'ya lo habías marcado'],
    ['CANCELLED_BY_CUSTOMER', 'canceló ese turno'],
    ['EXPIRED', 'ya no está esperando la seña'],
  ] as const)('si el turno ya estaba en %s no cambia nada y lo cuenta', (status, expected) => {
    expect(depositReviewAck({ appointment, outcome: 'unchanged', status }).body).toContain(expected);
  });

  it('una derivación atendida dice si el asistente vuelve a contestar', () => {
    expect(handoffAttendedAck({ customerName: 'Caro Pérez', outcome: 'resumed' }).body).toContain(
      'vuelve a contestar',
    );
    expect(handoffAttendedAck({ customerName: 'Caro Pérez', outcome: 'resolved' }).body).not.toContain(
      'vuelve a contestar',
    );
    expect(handoffAttendedAck({ customerName: 'Caro Pérez', outcome: 'already_resolved' }).body).toContain(
      'ya estaba',
    );
  });
});

describe('avisos a la clienta (4.5)', () => {
  it('seña confirmada: el texto fijo con el turno, el mismo que su plantilla', () => {
    const template = customerDepositConfirmedTemplate(appointment);

    expect(customerDepositConfirmed(appointment).body).toBe(
      '¡Seña recibida! Tu turno de Esmaltado semipermanente con Mica del lunes 5/10 10:00 quedó confirmado. ¡Te esperamos!',
    );
    expect(template).toMatchObject({ type: 'template', name: 'sena_confirmada' });
    expect(renderTemplate(template)).toBe(customerDepositConfirmed(appointment).body);
  });

  it('seña rechazada: el texto de su plantilla es el mismo', () => {
    expect(renderTemplate(customerDepositRejectedTemplate(appointment))).toBe(customerDepositRejected(appointment).body);
  });

  it('reserva vencida: ofrece otro horario, con el mismo texto que su plantilla (H10)', () => {
    const template = reservationExpiredTemplate(appointment);

    expect(reservationExpired(appointment).body).toBe(
      'Tu reserva de Esmaltado semipermanente del lunes 5/10 10:00 se liberó porque no nos llegó la seña a tiempo. ' +
        'Si querés otro horario, respondé este mensaje y te ayudamos.',
    );
    expect(template.name).toBe('reserva_vencida');
    expect(renderTemplate(template)).toBe(reservationExpired(appointment).body);
  });

  it('seña rechazada: el texto fijo, sin discutir el pago', () => {
    expect(customerDepositRejected(appointment).body).toBe(
      'No pudimos verificar la transferencia de la seña, así que el turno del lunes 5/10 10:00 quedó sin reservar. Si ya la hiciste, una persona del equipo te escribe por acá.',
    );
  });
});

const APPOINTMENT_ID = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

describe('recordatorios a la clienta (4.7, H10)', () => {
  it('el del día anterior: plantilla con el turno y los tres botones con su intención', () => {
    expect(appointmentReminder({ appointmentId: APPOINTMENT_ID, appointment })).toEqual({
      type: 'template',
      name: 'recordatorio_turno',
      language: 'es_AR',
      params: { servicio: 'Esmaltado semipermanente', profesional: 'Mica', fecha_hora: 'lunes 5/10 10:00' },
      buttonPayloads: [
        `recordatorio:${APPOINTMENT_ID}:confirmar`,
        `recordatorio:${APPOINTMENT_ID}:reprogramar`,
        `recordatorio:${APPOINTMENT_ID}:cancelar`,
      ],
    });
  });

  it('el corto: la hora y la dirección en una sola línea', () => {
    const message = shortAppointmentReminder({ appointment, address: 'San Martín 1234\nPlanta alta' });

    expect(message).toMatchObject({
      name: 'recordatorio_turno_corto',
      params: { hora: '10:00', servicio: 'Esmaltado semipermanente', direccion: 'San Martín 1234 Planta alta' },
    });
  });
});

describe('la versión con plantilla de los avisos a la dueña (8.2, H10)', () => {
  it('el comprobante: quién, cuánto y qué turno, con los mismos botones', () => {
    expect(depositReceiptTemplate({ notificationId: NOTICE, appointment, amountCents: 540_000 })).toMatchObject({
      name: 'aviso_comprobante',
      params: {
        clienta: 'Caro Pérez (+5492614000001)',
        monto: '$5.400',
        turno: 'Esmaltado semipermanente con Mica, lunes 5/10 10:00',
      },
      buttonPayloads: [`aviso:${NOTICE}:recibida`, `aviso:${NOTICE}:no_llego`],
    });
  });

  it('la derivación: motivo, resumen y hasta cuándo, con «Ya la atendí»', () => {
    const template = handoffTemplate({
      notificationId: NOTICE,
      appointment,
      reason: 'complaint',
      summary: 'Se quejó del turno de ayer',
      pausedUntil: localDateTimeToInstant('2026-10-05', '22:00', ZONE),
    });

    expect(template).toMatchObject({
      name: 'aviso_derivacion',
      params: {
        clienta: 'Caro Pérez (+5492614000001)',
        motivo: 'queja o reclamo',
        resumen: 'Se quejó del turno de ayer',
        hasta: 'lunes 5/10 22:00',
      },
      buttonPayloads: [`aviso:${NOTICE}:atendida`],
    });
  });

  it.each([
    [{ status: 'approved' as const, amountCents: 540_000 }, 'pagada ($5.400): la devolución o el traspaso los decidís vos'],
    [
      { status: 'in_review' as const, amountCents: 540_000 },
      'en verificación ($5.400): si la transferencia llegó, la devolución o el traspaso los decidís vos',
    ],
    [{ status: 'pending' as const, amountCents: 540_000 }, 'sin pagar'],
    [null, 'no llevaba'],
  ])('la cancelación dice el estado de la seña (%o)', (deposit, sena) => {
    expect(cancellationTemplate({ appointment, deposit })).toMatchObject({
      name: 'aviso_cancelacion',
      params: { clienta: 'Caro Pérez', turno: 'Esmaltado semipermanente con Mica, lunes 5/10 10:00', sena },
    });
  });

  it('la reprogramación: el horario anterior y el nuevo', () => {
    expect(
      rescheduleTemplate({ appointment, previousStart: localDateTimeToInstant('2026-10-02', '15:00', ZONE) }),
    ).toMatchObject({
      name: 'aviso_reprogramacion',
      params: {
        clienta: 'Caro Pérez',
        servicio: 'Esmaltado semipermanente',
        profesional: 'Mica',
        antes: 'viernes 2/10 15:00',
        despues: 'lunes 5/10 10:00',
      },
    });
  });
});
