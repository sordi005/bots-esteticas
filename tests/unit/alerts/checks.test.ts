import { describe, expect, it } from 'vitest';
import { evaluateAlertChecks, type AlertCheckInput } from '../../../src/modules/alerts/checks.js';

const TENANT_ID = '0f8b3c2e-6a51-4d4e-9b3f-2c1d0e9a8b7c';
const HANDOFF_ID = '5b1d2c3e-4f50-4a6b-8c7d-9e0f1a2b3c4d';
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

// Jueves 26/11/2026, 12:00 en Mendoza (15:00 UTC).
const THURSDAY_NOON = new Date('2026-11-26T15:00:00Z');

/** Un negocio sin nada para alertar; cada test cambia lo suyo. */
function input(overrides: Partial<AlertCheckInput> = {}): AlertCheckInput {
  return {
    tenantId: TENANT_ID,
    now: THURSDAY_NOON,
    timeZone: 'America/Argentina/Mendoza',
    coexistenceSince: null,
    lastEchoAt: null,
    oldestOpenHandoff: null,
    openHandoffs: 0,
    attendingNow: true,
    nextYearHolidays: 0,
    weeklyHandoffs: 0,
    weeklyConversations: 0,
    ...overrides,
  };
}

const ago = (ms: number) => new Date(THURSDAY_NOON.getTime() - ms);

describe('evaluateAlertChecks: las revisiones periódicas de 10.3', () => {
  it('un negocio al día no alerta nada', () => {
    expect(evaluateAlertChecks(input())).toEqual([]);
  });

  describe('sin ecos por más de 10 días', () => {
    it('alerta si el último eco tiene más de 10 días', () => {
      const alerts = evaluateAlertChecks(input({ coexistenceSince: ago(60 * DAY_MS), lastEchoAt: ago(10 * DAY_MS + 1) }));

      expect(alerts).toEqual([{ kind: 'echoes_missing', tenantId: TENANT_ID, ids: { daysWithoutEchoes: 10 } }]);
    });

    it('con un eco de hace justo 10 días todavía no alerta', () => {
      expect(evaluateAlertChecks(input({ coexistenceSince: ago(60 * DAY_MS), lastEchoAt: ago(10 * DAY_MS) }))).toEqual([]);
    });

    it('sin ningún eco cuenta desde que el número entró en coexistencia', () => {
      expect(evaluateAlertChecks(input({ coexistenceSince: ago(3 * DAY_MS) }))).toEqual([]);
      expect(evaluateAlertChecks(input({ coexistenceSince: ago(12 * DAY_MS) }))).toEqual([
        { kind: 'echoes_missing', tenantId: TENANT_ID, ids: { daysWithoutEchoes: 12 } },
      ]);
    });

    it('un negocio que no está en coexistencia nunca alerta por ecos', () => {
      expect(evaluateAlertChecks(input({ coexistenceSince: null, lastEchoAt: ago(30 * DAY_MS) }))).toEqual([]);
    });
  });

  describe('derivación sin resolver por más de 4 horas en horario de atención', () => {
    const waiting = { id: HANDOFF_ID, createdAt: ago(4 * HOUR_MS + 1) };

    it('alerta con la derivación más vieja y cuántas hay abiertas', () => {
      expect(evaluateAlertChecks(input({ oldestOpenHandoff: waiting, openHandoffs: 2 }))).toEqual([
        { kind: 'handoff_waiting', tenantId: TENANT_ID, ids: { handoffId: HANDOFF_ID, openHandoffs: 2 } },
      ]);
    });

    it('con el negocio cerrado no alerta: avisa al abrir', () => {
      expect(evaluateAlertChecks(input({ oldestOpenHandoff: waiting, openHandoffs: 1, attendingNow: false }))).toEqual([]);
    });

    it('una abierta hace justo 4 horas todavía no alerta', () => {
      const recent = { id: HANDOFF_ID, createdAt: ago(4 * HOUR_MS) };

      expect(evaluateAlertChecks(input({ oldestOpenHandoff: recent, openHandoffs: 1 }))).toEqual([]);
    });
  });

  describe('feriados del año siguiente sin cargar', () => {
    const DECEMBER_FIRST = new Date('2026-12-01T03:00:00Z'); // 00:00 en Mendoza

    it('desde el 1 de diciembre, sin ningún feriado del año siguiente, alerta una sola vez para todos', () => {
      expect(evaluateAlertChecks(input({ now: DECEMBER_FIRST, nextYearHolidays: 0 }))).toEqual([
        { kind: 'holidays_missing', tenantId: null, detail: '2027' },
      ]);
    });

    it('con los feriados cargados no alerta', () => {
      expect(evaluateAlertChecks(input({ now: DECEMBER_FIRST, nextYearHolidays: 9 }))).toEqual([]);
    });

    it('el 30 de noviembre a la noche en Mendoza todavía no: el día es el del negocio', () => {
      const lastNovemberNight = new Date('2026-12-01T02:59:00Z');

      expect(evaluateAlertChecks(input({ now: lastNovemberNight, nextYearHolidays: 0 }))).toEqual([]);
    });
  });

  describe('tasa de derivaciones mayor al 30 % en una semana', () => {
    const MONDAY = new Date('2026-11-30T12:00:00Z'); // lunes 9:00 en Mendoza

    it('los lunes alerta si las derivaciones pasan el 30 % de las conversaciones, una vez por semana', () => {
      expect(evaluateAlertChecks(input({ now: MONDAY, weeklyHandoffs: 4, weeklyConversations: 10 }))).toEqual([
        {
          kind: 'handoff_rate',
          tenantId: TENANT_ID,
          detail: 'semana-2026-11-30',
          ids: { weeklyHandoffs: 4, weeklyConversations: 10 },
        },
      ]);
    });

    it('justo el 30 % no alerta', () => {
      expect(evaluateAlertChecks(input({ now: MONDAY, weeklyHandoffs: 3, weeklyConversations: 10 }))).toEqual([]);
    });

    it('otro día de la semana no alerta, aunque la tasa sea alta', () => {
      expect(evaluateAlertChecks(input({ weeklyHandoffs: 9, weeklyConversations: 10 }))).toEqual([]);
    });

    it('sin conversaciones en la semana no alerta', () => {
      expect(evaluateAlertChecks(input({ now: MONDAY, weeklyHandoffs: 0, weeklyConversations: 0 }))).toEqual([]);
    });
  });
});
