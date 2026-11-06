import { describe, expect, it } from 'vitest';
import {
  APPOINTMENT_EVENT_DESCRIPTION,
  appointmentEventAction,
  eventIdFor,
} from '../../../src/modules/calendar/appointment-event.js';
import type { AppointmentStatus } from '../../../src/modules/scheduling/appointment-state-machine.js';

const APPOINTMENT_ID = 'cffcb42e-ef8b-4a0e-9f9b-9b555253f017';
const START = new Date('2026-11-05T13:00:00Z');

function actionFor(status: AppointmentStatus, overrides: { customerName?: string | null; profileName?: string | null } = {}) {
  return appointmentEventAction({
    appointmentId: APPOINTMENT_ID,
    status,
    serviceName: 'Esmaltado semipermanente',
    customerName: 'Laura',
    profileName: 'Lau 💅',
    start: START,
    durationMinutes: 60,
    timeZone: 'America/Argentina/Mendoza',
    ...overrides,
  });
}

describe('eventIdFor: el id del evento sale del id del turno (D7)', () => {
  it('es el uuid sin guiones, que Google acepta (base32hex)', () => {
    expect(eventIdFor(APPOINTMENT_ID)).toBe('cffcb42eef8b4a0e9f9b9b555253f017');
    expect(eventIdFor(APPOINTMENT_ID)).toMatch(/^[0-9a-v]{5,1024}$/);
  });
});

describe('appointmentEventAction: qué turnos tienen evento y con qué texto (8.4, D8 y D9)', () => {
  it('confirmado: el evento con el servicio y el nombre de la clienta, sin teléfono, hasta el fin sin el margen', () => {
    expect(actionFor('CONFIRMED')).toEqual({
      kind: 'save',
      event: {
        id: 'cffcb42eef8b4a0e9f9b9b555253f017',
        appointmentId: APPOINTMENT_ID,
        summary: 'Esmaltado semipermanente · Laura',
        description: APPOINTMENT_EVENT_DESCRIPTION,
        start: START,
        end: new Date('2026-11-05T14:00:00Z'),
        timeZone: 'America/Argentina/Mendoza',
        tentative: false,
      },
    });
  });

  it('la descripción explica que mover el evento no mueve el turno', () => {
    expect(APPOINTMENT_EVENT_DESCRIPTION).toBe(
      'Turno reservado por WhatsApp. Si lo cambiás acá, el turno no cambia: pedíselo al asistente o avisanos.',
    );
  });

  it('con la seña en verificación: provisorio y avisado en el título', () => {
    expect(actionFor('DEPOSIT_REVIEW')).toMatchObject({
      kind: 'save',
      event: { summary: 'Esmaltado semipermanente · Laura (seña en verificación)', tentative: true },
    });
  });

  it('sin nombre cargado, usa el nombre de perfil de WhatsApp; sin ninguno, "Clienta"', () => {
    expect(actionFor('CONFIRMED', { customerName: null })).toMatchObject({
      event: { summary: 'Esmaltado semipermanente · Lau 💅' },
    });
    expect(actionFor('CONFIRMED', { customerName: null, profileName: null })).toMatchObject({
      event: { summary: 'Esmaltado semipermanente · Clienta' },
    });
  });

  it.each<AppointmentStatus>(['COMPLETED', 'NO_SHOW'])('%s: el evento queda como está (historial de la agenda)', (status) => {
    expect(actionFor(status)).toEqual({ kind: 'keep' });
  });

  it.each<AppointmentStatus>(['PENDING_DEPOSIT', 'EXPIRED', 'DEPOSIT_REJECTED', 'CANCELLED_BY_CUSTOMER', 'CANCELLED_BY_BUSINESS'])(
    '%s: sin evento (se borra si lo había)',
    (status) => {
      expect(actionFor(status)).toEqual({ kind: 'delete', eventId: 'cffcb42eef8b4a0e9f9b9b555253f017' });
    },
  );
});
