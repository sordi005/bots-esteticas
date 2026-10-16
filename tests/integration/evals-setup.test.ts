import { count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LlmRequest } from '../../src/modules/conversation/agent/llm-client.js';
import { CHOICE_MARKER } from '../../src/modules/conversation/agent/message-text.js';
import { appointments } from '../../src/modules/scheduling/schema.js';
import { DEMO_TENANT_ID, seedEsteticaEjemplo } from '../../src/seeds/estetica-ejemplo.js';
import { createDatabase } from '../../src/shared/db.js';
import { evalCases } from '../evals/cases.js';
import type { EvalCase, EvalResult } from '../evals/evaluate.js';
import { EvalPreparationError, runEvalCase } from '../evals/run-case.js';
import { callTools, finalAnswer, handoffAnswer, scriptedLlm, type ScriptStep } from '../support/fake-llm.js';
import { testDatabaseUrl } from './support/database.js';
import { single } from './support/fixtures.js';

/**
 * Lo que arma el corredor de evaluaciones antes y después de la vuelta (tests/evals/): el estado
 * previo (nombre, turnos, historial), los mensajes que no son texto, la hora movida, el estado
 * que queda en la base y la limpieza. Con un modelo falso guionado: no gasta plata.
 */

const database = createDatabase(testDatabaseUrl());
const { db } = database;

const SEMI = 'Esmaltado semipermanente';
// El martes 13/10 a las 17:00 con Mica es válido en el seed (martes, bloque de 15 a 20).
const TUESDAY = '2026-10-13 17:00';
/** Una clienta con turnos tiene nombre: reservar lo guarda siempre. */
const NAMED = 'Caro Pérez';

beforeAll(() => seedEsteticaEjemplo(db));
afterAll(() => database.close());

function run(evalCase: EvalCase, script: ScriptStep[] = [finalAnswer('ok')]) {
  const { llm, requests } = scriptedLlm(script);
  const result = runEvalCase({ db, llm, tenantId: DEMO_TENANT_ID }, evalCase);
  return { result, requests };
}

const countAppointments = async () =>
  single(await db.select({ total: count() }).from(appointments).where(eq(appointments.tenantId, DEMO_TENANT_ID))).total;

function lastToolOutputs(request: LlmRequest): Record<string, unknown>[] {
  const last = request.messages.at(-1);
  if (last?.role !== 'tool_results') throw new Error('El último mensaje no son resultados de herramientas');
  return last.results.map((result) => JSON.parse(result.content) as Record<string, unknown>);
}

/** La llamada n al modelo (falla con un mensaje claro si el modelo no se llamó tantas veces). */
function request(requests: LlmRequest[], index: number): LlmRequest {
  const found = requests[index];
  if (!found) throw new Error(`El modelo se llamó ${String(requests.length)} veces y se esperaba la llamada ${String(index + 1)}`);
  return found;
}

/** Lo que dijeron la clienta y el asistente antes de que el modelo pida herramientas, como texto. */
const dialogue = (request: LlmRequest) =>
  request.messages.flatMap((message) =>
    message.role === 'user' || message.role === 'assistant' ? [{ role: message.role, text: message.text }] : [],
  );

/** El turnoId (`turno:<uuid>`) del primer turno que devolvió listar_turnos_de_la_clienta. */
const firstAppointmentId = (request: LlmRequest) =>
  (lastToolOutputs(request)[0] as { turnos: { turnoId: string }[] }).turnos[0]?.turnoId ?? '';

/** El horario del miércoles 14/10 a las 15:30 (18:30 UTC) para mover el turno de la lista (decisión 28). */
const wednesdayToMove = (request: LlmRequest) =>
  `reprogramar:${firstAppointmentId(request).replace('turno:', '')}:2026-10-14T18:30:00.000Z`;

/** La clienta tocó el horario del viernes 9/10 a las 15:00 con Mica: crear_reserva solo actúa sobre una elección suya. */
const FRIDAY_CHOICE = {
  eleccion: { tipo: 'horario', servicio: SEMI, profesional: 'Mica', inicio: '2026-10-09 15:00' },
  titulo: 'vie 9/10 15:00',
} as const;

const withAppointment = (overrides: Partial<NonNullable<NonNullable<EvalCase['preparar']>['turnos']>[number]> = {}) => ({
  clave: 'martes',
  servicio: SEMI,
  profesional: 'Mica',
  inicio: TUESDAY,
  ...overrides,
});

const caseWith = (overrides: Partial<EvalCase>): EvalCase => ({
  nombre: 'caso_de_prueba',
  mensajes: ['hola'],
  espera: {},
  ...overrides,
});

describe('preparar: el nombre', () => {
  it('con nombre, el contexto de la vuelta dice que ya está cargado', async () => {
    const { result, requests } = run(caseWith({ preparar: { nombre: 'Caro Pérez' } }));
    const evaluated = await result;

    expect(requests[0]?.turnContext).toContain('Nombre para el turno: Caro Pérez (ya está cargado');
    expect(evaluated.estado.nombreClienta).toBe('Caro Pérez');
  });

  it('sin nombre, la ficha queda sin nombre y el contexto pide el nombre', async () => {
    const { result, requests } = run(caseWith({}));
    const evaluated = await result;

    expect(requests[0]?.turnContext).toContain('Nombre para el turno: no está cargado');
    expect(evaluated.estado.nombreClienta).toBeNull();
  });
});

describe('preparar: los turnos', () => {
  it('un turno de la clienta se crea con booking.ts: queda pendiente de seña y es lo que lista la herramienta', async () => {
    const { result, requests } = run(caseWith({ mensajes: ['qué turnos tengo?'], preparar: { nombre: NAMED, turnos: [withAppointment()] } }), [
      callTools([{ name: 'listar_turnos_de_la_clienta' }]),
      finalAnswer('Tenés un turno'),
    ]);
    const evaluated = await result;

    expect(evaluated.estado.turnos).toEqual([
      { clave: 'martes', de: 'clienta', servicio: SEMI, profesional: 'Mica', inicio: TUESDAY, estado: 'PENDING_DEPOSIT' },
    ]);
    const listed = lastToolOutputs(request(requests, 1))[0] as { turnos: Record<string, unknown>[] };
    expect(listed.turnos).toHaveLength(1);
    expect(listed.turnos[0]).toMatchObject({ fecha: 'martes 13/10 17:00', estado: 'pendiente de seña' });
    // Se reservó unos minutos antes de la hora fija: la seña todavía no venció.
    expect(listed.turnos[0]?.sena).toMatchObject({ monto: '$5.400', estado: 'pendiente de pago' });
  });

  it('un turno de otra clienta aparece en el estado como de otra y no en los turnos de la clienta', async () => {
    const turnos = [withAppointment({ clave: 'maria', otraClienta: 'María González', inicio: '2026-10-14 11:00' })];
    const { result, requests } = run(caseWith({ preparar: { nombre: NAMED, turnos } }), [
      callTools([{ name: 'listar_turnos_de_la_clienta' }]),
      finalAnswer('No tenés turnos'),
    ]);
    const evaluated = await result;

    expect(evaluated.estado.turnos).toEqual([
      { clave: 'maria', de: 'otra', servicio: SEMI, profesional: 'Mica', inicio: '2026-10-14 11:00', estado: 'PENDING_DEPOSIT' },
    ]);
    expect(lastToolOutputs(request(requests, 1))[0]).toMatchObject({ turnos: [] });
  });

  it('con la seña aprobada el turno queda confirmado y la seña paga', async () => {
    const { result, requests } = run(
      caseWith({ mensajes: ['mis turnos'], preparar: { nombre: NAMED, turnos: [withAppointment({ senaAprobada: true })] } }),
      [callTools([{ name: 'listar_turnos_de_la_clienta' }]), finalAnswer('ok')],
    );
    const evaluated = await result;

    expect(evaluated.estado.turnos[0]?.estado).toBe('CONFIRMED');
    const listed = lastToolOutputs(request(requests, 1))[0] as { turnos: Record<string, unknown>[] };
    expect(listed.turnos[0]).toMatchObject({ estado: 'confirmado', sena: { monto: '$5.400', estado: 'pagada' } });
  });

  it('un turno reprogramado queda en su último inicio y ya usó la reprogramación que conserva la seña', async () => {
    const turnos = [withAppointment({ senaAprobada: true, reprogramadoDesde: ['2026-10-13 15:00'] })];
    const evalCase = caseWith({ mensajes: ['pasalo al miércoles'], preparar: { nombre: NAMED, turnos } });
    const { result, requests } = run(evalCase, [
      callTools([{ name: 'listar_turnos_de_la_clienta' }]),
      (request) =>
        callTools([
          {
            name: 'reprogramar_turno',
            // El horario del miércoles 14/10 15:30 con Mica es válido; la política lo rechaza, no la grilla.
            input: { horario_id: wednesdayToMove(request) },
          },
        ]),
      finalAnswer('No se puede'),
    ]);
    const evaluated = await result;

    expect(requests).toHaveLength(3);
    expect(lastToolOutputs(request(requests, 2))[0]).toMatchObject({ reprogramado: false, derivada: true });
    expect(evaluated.estado.turnos[0]).toMatchObject({ inicio: TUESDAY, estado: 'CONFIRMED' });
    expect(evaluated.estado.derivaciones.map((handoff) => handoff.motivo)).toEqual(['policy_exception']);
    expect(evaluated.estado.pausada).toBe(true);
  });

  it('sin la reprogramación usada, la misma herramienta sí mueve el turno', async () => {
    const turnos = [withAppointment({ senaAprobada: true })];
    const wednesday = {
      eleccion: { tipo: 'reprogramar', turno: 'martes', inicio: '2026-10-14 15:30' },
      titulo: 'mié 14/10 15:30',
    } as const;
    const { result } = run(caseWith({ mensajes: ['pasalo al miércoles', wednesday], preparar: { nombre: NAMED, turnos } }), [
      callTools([{ name: 'listar_turnos_de_la_clienta' }]),
      (request) =>
        callTools([
          {
            name: 'reprogramar_turno',
            input: { horario_id: wednesdayToMove(request) },
          },
        ]),
      finalAnswer('Listo'),
    ]);
    const evaluated = await result;

    expect(evaluated.estado.turnos[0]).toMatchObject({ clave: 'martes', inicio: '2026-10-14 15:30', estado: 'CONFIRMED' });
    expect(evaluated.estado.derivaciones).toEqual([]);
    expect(evaluated.estado.pausada).toBe(false);
  });

  it('una elección para reprogramar usa el id reprogramar: del turno del caso, y el modelo la ve ya resuelta', async () => {
    const wednesday = {
      eleccion: { tipo: 'reprogramar', turno: 'martes', inicio: '2026-10-14 15:30' },
      titulo: 'mié 14/10 15:30',
    } as const;
    const { result, requests } = run(caseWith({ mensajes: [wednesday], preparar: { nombre: NAMED, turnos: [withAppointment()] } }));
    await result;

    expect(requests[0]?.turnContext).toMatch(
      /Eligió el horario miércoles 14\/10 15:30 para pasar su turno del martes 13\/10 17:00 \(Esmaltado semipermanente con Mica\), horario_id=reprogramar:[0-9a-f-]{36}:2026-10-14T18:30:00\.000Z; sigue libre/,
    );
    expect(requests[0]?.turnContext).toContain('llamá a reprogramar_turno con ese horario_id');
  });

  it('con la hora movida los turnos también se crean unos minutos antes: la seña todavía no venció', async () => {
    const { result } = run(caseWith({ preparar: { nombre: NAMED, turnos: [withAppointment()] }, ahora: '2026-10-08 20:30' }));
    const evaluated = await result;

    expect(evaluated.estado.turnos[0]?.estado).toBe('PENDING_DEPOSIT');
  });
});

describe('preparar: errores del caso', () => {
  it('un horario ocupado por el propio caso no se puede reservar, y lo que ya se creó se limpia', async () => {
    const before = await countAppointments();
    const turnos = [withAppointment({ clave: 'uno' }), withAppointment({ clave: 'dos', inicio: '2026-10-13 17:15' })];

    await expect(run(caseWith({ preparar: { nombre: NAMED, turnos } })).result).rejects.toThrow(EvalPreparationError);
    await expect(run(caseWith({ preparar: { nombre: NAMED, turnos } })).result).rejects.toThrow(/no se pudo reservar.*slot_taken/);

    expect(await countAppointments()).toBe(before);
  });

  it('un turno en un horario que no existe en el seed (un domingo) falla con un error de preparación', async () => {
    const evalCase = caseWith({ nombre: 'domingo', preparar: { nombre: NAMED, turnos: [withAppointment({ inicio: '2026-10-11 10:00' })] } });

    await expect(run(evalCase).result).rejects.toThrow(/«domingo».*2026-10-11 10:00.*slot_unavailable/);
  });

  it('un servicio o una profesional que no están en el seed', async () => {
    const service = caseWith({ preparar: { nombre: NAMED, turnos: [withAppointment({ servicio: 'Masaje' })] } });
    const professional = caseWith({ preparar: { nombre: NAMED, turnos: [withAppointment({ profesional: 'Lu' })] } });

    await expect(run(service).result).rejects.toThrow(/No existe el servicio «Masaje»/);
    await expect(run(professional).result).rejects.toThrow(/No existe la profesional «Lu»/);
  });

  it('una fecha mal escrita', async () => {
    const evalCase = caseWith({ preparar: { nombre: NAMED, turnos: [withAppointment({ inicio: '13/10 17:00' })] } });

    await expect(run(evalCase).result).rejects.toThrow(/AAAA-MM-DD HH:MM/);
  });

  it('una elección de horario que no está libre según el seed es un error del caso, no del agente', async () => {
    const holiday = { tipo: 'horario' as const, servicio: SEMI, profesional: 'Mica', inicio: '2026-10-12 10:00' };
    const evalCase = caseWith({ nombre: 'feriado_mal', mensajes: [{ eleccion: holiday, titulo: 'lun 12/10 10:00' }] });

    await expect(run(evalCase).result).rejects.toThrow(/«feriado_mal».*horario.*2026-10-12 10:00.*no está libre según el seed/);
  });

  it('lo mismo si la elección del horario está en el historial', async () => {
    const sunday = { tipo: 'horario' as const, servicio: SEMI, profesional: 'Mica', inicio: '2026-10-11 10:00' };
    const evalCase = caseWith({ preparar: { historial: [{ clienta: { eleccion: sunday, titulo: 'dom 11/10 10:00' } }] } });

    await expect(run(evalCase).result).rejects.toThrow(/no está libre según el seed/);
  });

  it('una elección para reprogramar a un horario que no está libre según el seed es un error del caso', async () => {
    const sunday = { tipo: 'reprogramar' as const, turno: 'martes', inicio: '2026-10-18 10:00' };
    const evalCase = caseWith({
      nombre: 'domingo_mal',
      mensajes: [{ eleccion: sunday, titulo: 'dom 18/10 10:00' }],
      preparar: { nombre: NAMED, turnos: [withAppointment()] },
    });

    await expect(run(evalCase).result).rejects.toThrow(/«domingo_mal».*reprogramar.*2026-10-18 10:00.*no está libre según el seed/);
  });

  it('una elección para reprogramar que nombra un turno que el caso no preparó, o que es de otra clienta', async () => {
    const ghost = caseWith({
      mensajes: [{ eleccion: { tipo: 'reprogramar', turno: 'fantasma', inicio: '2026-10-14 15:30' }, titulo: 'x' }],
    });
    const theirs = caseWith({
      mensajes: [{ eleccion: { tipo: 'reprogramar', turno: 'maria', inicio: '2026-10-14 15:30' }, titulo: 'x' }],
      preparar: { nombre: NAMED, turnos: [withAppointment({ clave: 'maria', otraClienta: 'María González' })] },
    });

    await expect(run(ghost).result).rejects.toThrow(/turno «fantasma»/);
    await expect(run(theirs).result).rejects.toThrow(/«maria».*es de otra clienta/);
  });

  it('una clienta con turnos propios y sin nombre es un caso inconsistente: reservar siempre guarda el nombre', async () => {
    const evalCase = caseWith({ nombre: 'sin_nombre', preparar: { turnos: [withAppointment()] } });

    await expect(run(evalCase).result).rejects.toThrow(/«sin_nombre».*tiene turnos pero no tiene nombre/);
  });

  it('los turnos de otra clienta no piden nombre para la clienta del caso', async () => {
    const turnos = [withAppointment({ clave: 'maria', otraClienta: 'María González' })];

    await expect(run(caseWith({ preparar: { nombre: NAMED, turnos } })).result).resolves.toBeDefined();
  });

  it('una elección que nombra un turno que el caso no preparó', async () => {
    const evalCase = caseWith({ mensajes: [{ eleccion: { tipo: 'cancelar', turno: 'fantasma' }, titulo: 'Sí, cancelar' }] });

    await expect(run(evalCase).result).rejects.toThrow(/turno «fantasma»/);
  });

  it('una elección que toca el turno de otra clienta no es válida (los botones son de la clienta del caso)', async () => {
    const evalCase = caseWith({
      mensajes: [{ eleccion: { tipo: 'cancelar', turno: 'maria' }, titulo: 'Sí, cancelar' }],
      preparar: { nombre: NAMED, turnos: [withAppointment({ clave: 'maria', otraClienta: 'María González' })] },
    });

    await expect(run(evalCase).result).rejects.toThrow(/«maria».*es de otra clienta/);
  });
});

describe('preparar: el historial', () => {
  it('llega al modelo como mensajes anteriores, en orden, con las opciones del asistente y el id de la elección', async () => {
    const slot = { tipo: 'horario' as const, servicio: SEMI, profesional: 'Mica', inicio: '2026-10-09 15:00' };
    const evalCase = caseWith({
      mensajes: ['Caro Pérez'],
      preparar: {
        historial: [
          { clienta: 'tenés turno para semi el viernes?' },
          { asistente: 'Para el viernes tengo:', botones: ['vie 9/10 15:00', 'vie 9/10 16:30'] },
          { clienta: { eleccion: slot, titulo: 'vie 9/10 15:00' } },
          { asistente: '¿A nombre de quién lo anoto?' },
        ],
      },
    });
    const { result, requests } = run(evalCase);
    await result;

    const messages = dialogue(request(requests, 0));
    expect(messages).toHaveLength(5);
    expect(messages[0]).toEqual({ role: 'user', text: 'tenés turno para semi el viernes?' });
    expect(messages[1]).toEqual({
      role: 'assistant',
      text: 'Para el viernes tengo:\n[Botones: vie 9/10 15:00 | vie 9/10 16:30]',
    });
    expect(messages[2]?.text).toMatch(
      /^\[La clienta tocó una opción de un botón o una lista\] «vie 9\/10 15:00» \(opción elegida: horario:[0-9a-f-]{36}:[0-9a-f-]{36}:2026-10-09T18:00:00\.000Z\)$/,
    );
    expect(messages[3]).toEqual({ role: 'assistant', text: '¿A nombre de quién lo anoto?' });
    expect(messages[4]).toEqual({ role: 'user', text: 'Caro Pérez' });
  });

  it('con un mensaje del asistente reciente la conversación no es nueva', async () => {
    const { result, requests } = run(
      caseWith({ preparar: { historial: [{ clienta: 'hola' }, { asistente: 'Hola, soy Luna' }] } }),
    );
    await result;

    expect(requests[0]?.turnContext).toContain('Conversación nueva: no');
  });

  it('un asistente con más de 3 opciones se guarda como lista', async () => {
    const botones = ['uno', 'dos', 'tres', 'cuatro'];
    const { result, requests } = run(
      caseWith({ preparar: { historial: [{ clienta: 'hola' }, { asistente: 'Elegí', botones }] } }),
    );
    await result;

    expect(dialogue(request(requests, 0))[1]?.text).toBe('Elegí\n[Opciones: uno | dos | tres | cuatro]');
  });
});

describe('mensajes que no son texto', () => {
  it('«Sí, cancelar» llega como la elección resuelta de su turno', async () => {
    const evalCase = caseWith({
      mensajes: [{ eleccion: { tipo: 'cancelar', turno: 'martes' }, titulo: 'Sí, cancelar' }],
      preparar: { nombre: NAMED, turnos: [withAppointment()] },
    });
    const { result, requests } = run(evalCase);
    await result;

    expect(requests[0]?.messages.at(-1)).toEqual({ role: 'user', text: CHOICE_MARKER });
    expect(requests[0]?.turnContext).toMatch(
      /Confirmó que quiere cancelar el turno del martes 13\/10 17:00 \(Esmaltado semipermanente con Mica, pendiente de seña\), turno_id=turno:[0-9a-f-]{36}: llamá a cancelar_turno con confirmada=true/,
    );
  });

  it('un horario tocado llega con su servicio, su profesional y si sigue libre', async () => {
    const slot = { tipo: 'horario' as const, servicio: SEMI, profesional: 'Mica', inicio: '2026-10-14 15:30' };
    const { result, requests } = run(caseWith({ mensajes: [{ eleccion: slot, titulo: 'mié 14/10 15:30' }] }));
    await result;

    expect(requests[0]?.turnContext).toContain(
      'Eligió el horario miércoles 14/10 15:30 con Mica para Esmaltado semipermanente (60 min)',
    );
    expect(requests[0]?.turnContext).toContain('sigue libre');
  });

  it('un turno tocado llega como su turno_id', async () => {
    const evalCase = caseWith({
      mensajes: [{ eleccion: { tipo: 'turno', turno: 'martes' }, titulo: 'mar 13/10 17:00' }],
      preparar: { nombre: NAMED, turnos: [withAppointment()] },
    });
    const { result, requests } = run(evalCase);
    await result;

    expect(requests[0]?.turnContext).toMatch(/Eligió su turno del martes 13\/10 17:00 .*turno_id=turno:[0-9a-f-]{36}/);
  });

  it('una imagen llega como [Imagen] con lo que escribió', async () => {
    const { result, requests } = run(caseWith({ mensajes: [{ imagen: 'quiero este diseño' }] }));
    await result;

    expect(requests[0]?.messages.at(-1)).toEqual({ role: 'user', text: '[Imagen] «quiero este diseño»' });
  });

  it('varios mensajes de distinto tipo van en orden', async () => {
    const { result, requests } = run(caseWith({ mensajes: ['mirá', { imagen: null }, 'este'] }));
    await result;

    expect(dialogue(request(requests, 0)).map((message) => message.text)).toEqual(['mirá', '[Imagen]', 'este']);
  });
});

describe('ahora', () => {
  it('mueve la hora de la vuelta: el contexto y las opciones usan esa hora', async () => {
    const { result, requests } = run(caseWith({ ahora: '2026-10-08 20:30' }));
    await result;

    expect(requests[0]?.turnContext).toContain('jueves 8/10/2026 20:30');
  });

  it('sin ahora, la hora fija: jueves 8/10 a las 10:00', async () => {
    const { result, requests } = run(caseWith({}));
    await result;

    expect(requests[0]?.turnContext).toContain('jueves 8/10/2026 10:00');
  });
});

describe('el estado que queda en la base', () => {
  it('un turno que crea el agente figura sin clave, con el nombre que guardó', async () => {
    const slotId =
      'horario:00000000-0000-4000-8000-000000000201:00000000-0000-4000-8000-000000000101:2026-10-09T18:00:00.000Z';
    const { result } = run(caseWith({ mensajes: [FRIDAY_CHOICE, 'Caro Pérez'] }), [
      callTools([{ name: 'crear_reserva', input: { horario_id: slotId, nombre: 'Caro Pérez' } }]),
      // Con seña, la respuesta lleva el alias (4.5): si no, el ciclo pediría otra vuelta.
      finalAnswer('Listo, transferí la seña al alias estetica.ejemplo'),
    ]);
    const evaluated = await result;

    expect(evaluated.estado.turnos).toEqual([
      { clave: null, de: 'clienta', servicio: SEMI, profesional: 'Mica', inicio: '2026-10-09 15:00', estado: 'PENDING_DEPOSIT' },
    ]);
    expect(evaluated.estado.nombreClienta).toBe('Caro Pérez');
    expect(evaluated.estado.derivaciones).toEqual([]);
    expect(evaluated.estado.pausada).toBe(false);
  });

  it('una derivación figura con su motivo y su resumen, y la conversación pausada', async () => {
    const { result } = run(caseWith({ mensajes: ['quiero hablar con una persona'] }), [
      handoffAnswer('Una persona te responde', { motivo: 'pedido_de_la_clienta', resumen: 'Quiere hablar con una persona' }),
    ]);
    const evaluated: EvalResult = await result;

    expect(evaluated.estado.derivaciones).toEqual([{ motivo: 'customer_request', resumen: 'Quiere hablar con una persona' }]);
    expect(evaluated.estado.pausada).toBe(true);
  });

  it('un tema sensible guarda el resumen fijo y no lo que escribió el modelo', async () => {
    const { result } = run(caseWith({ mensajes: ['estoy embarazada, puedo hacerme el lifting?'] }), [
      handoffAnswer('Eso lo ve una persona', { motivo: 'tema_sensible', resumen: 'Embarazada' }),
    ]);
    const evaluated = await result;

    expect(evaluated.estado.derivaciones).toEqual([{ motivo: 'sensitive_topic', resumen: 'Tema sensible: ver la conversación' }]);
  });
});

describe('la limpieza', () => {
  it('después de cada caso, los turnos que creó quedan borrados y el horario vuelve a estar libre', async () => {
    const before = await countAppointments();
    const evalCase = caseWith({
      preparar: { nombre: NAMED, turnos: [withAppointment(), withAppointment({ clave: 'otra', otraClienta: 'María González', inicio: '2026-10-14 11:00' })] },
    });

    await run(evalCase).result;
    expect(await countAppointments()).toBe(before);

    // Si no se hubiera limpiado, esta segunda corrida chocaría con el mismo horario.
    await expect(run(evalCase).result).resolves.toBeDefined();
    expect(await countAppointments()).toBe(before);
  });

  it('también limpia el turno que creó el agente', async () => {
    const before = await countAppointments();
    const slotId =
      'horario:00000000-0000-4000-8000-000000000201:00000000-0000-4000-8000-000000000101:2026-10-09T18:00:00.000Z';
    const script = () => [
      callTools([{ name: 'crear_reserva', input: { horario_id: slotId, nombre: 'Caro Pérez' } }]),
      // Con seña, la respuesta lleva el alias (4.5): si no, el ciclo pediría otra vuelta.
      finalAnswer('Listo, transferí la seña al alias estetica.ejemplo'),
    ];

    await run(caseWith({ mensajes: [FRIDAY_CHOICE] }), script()).result;
    expect(await countAppointments()).toBe(before);
    // El mismo horario se puede volver a reservar en el caso siguiente.
    const second = await run(caseWith({ mensajes: [FRIDAY_CHOICE] }), script()).result;
    expect(second.estado.turnos).toHaveLength(1);
  });
});

describe('los casos de cases.ts contra el seed', () => {
  // Un modelo falso que solo contesta: lo que se prueba es que la preparación sea válida (horarios que
  // existen en el seed, nombres de servicios y profesionales, claves de turnos), sin gastar plata.
  it.each(evalCases)('$nombre se puede preparar y correr', async (evalCase) => {
    const before = await countAppointments();

    // Con dos señas pendientes el código deriva sin llamar al modelo (4.5): esa vuelta tiene su propio motivo.
    const outcome = evalCase.nombre === 'sena_comprobante_dos_senas' ? 'handoff_payment_issue' : 'replied';
    await expect(run(evalCase, [finalAnswer('ok')]).result).resolves.toMatchObject({ outcome });

    expect(await countAppointments()).toBe(before);
  });
});
