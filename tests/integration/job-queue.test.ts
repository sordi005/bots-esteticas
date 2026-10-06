import { and, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  claimJobs,
  completeJob,
  EXPIRED_LEASE_ERROR,
  failJob,
  scheduleJob,
  type ClaimedJob,
} from '../../src/modules/jobs/queue.js';
import { scheduledJobs } from '../../src/modules/jobs/schema.js';
import { createDatabase } from '../../src/shared/db.js';
import { testDatabaseUrl } from './support/database.js';
import { createTenantFixture, single } from './support/fixtures.js';

const database = createDatabase(testDatabaseUrl());
const { db } = database;

afterAll(() => database.close());

const T0 = new Date('2026-10-06T15:00:00.000Z');
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1_000);
const LEASE_MS = 120_000;
const MAX_ATTEMPTS = 3;

let tenantId: string;

// La cola es una sola para todos los negocios: cada test arranca sin tareas, así un
// claim no toma las que dejó otro test.
beforeEach(async () => {
  await db.delete(scheduledJobs);
  ({ tenantId } = await createTenantFixture(db));
});

function schedule(key: string, runAt: Date, payload: Record<string, unknown> = {}) {
  return scheduleJob(db, { tenantId, kind: 'process_conversation', key, payload, runAt });
}

function claim(now: Date, limit = 10) {
  return claimJobs(db, {
    kinds: ['process_conversation'],
    limit,
    now,
    leaseMs: LEASE_MS,
    maxAttempts: MAX_ATTEMPTS,
  });
}

async function claimOne(now: Date): Promise<ClaimedJob> {
  return single(await claim(now));
}

async function readJob(key: string, tenant = tenantId) {
  return single(
    await db
      .select()
      .from(scheduledJobs)
      .where(and(eq(scheduledJobs.tenantId, tenant), eq(scheduledJobs.key, key))),
  );
}

describe('scheduleJob: una fila por tarea y clave (sección 6.7)', () => {
  it('programa una tarea nueva como pendiente', async () => {
    await schedule('conversacion-1', at(4), { conversationId: 'conversacion-1' });

    expect(await readJob('conversacion-1')).toMatchObject({
      kind: 'process_conversation',
      status: 'pending',
      runAt: at(4),
      attempts: 0,
      payload: { conversationId: 'conversacion-1' },
      rerunAt: null,
      lockToken: null,
    });
  });

  it('si ya estaba pendiente, la mueve a la nueva hora: así se agrupan los mensajes', async () => {
    await schedule('conversacion-1', at(4));
    await schedule('conversacion-1', at(6));

    const rows = await db.select().from(scheduledJobs).where(eq(scheduledJobs.tenantId, tenantId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'pending', runAt: at(6) });
  });

  it('si se está ejecutando, no la toca: anota que hay que volver a ejecutarla', async () => {
    await schedule('conversacion-1', at(0));
    const running = await claimOne(at(0));

    await schedule('conversacion-1', at(10));

    expect(await readJob('conversacion-1')).toMatchObject({
      status: 'running',
      runAt: at(0),
      rerunAt: at(10),
      lockToken: running.lockToken,
    });
  });

  it.each([
    ['terminó', (job: ClaimedJob) => completeJob(db, job)],
    ['falló', (job: ClaimedJob) => failJob(db, job, { error: 'Meta no responde', retryAt: null })],
  ])('si %s, vuelve a pendiente con los intentos en cero', async (_estado, finish) => {
    await schedule('conversacion-1', at(0));
    await finish(await claimOne(at(0)));

    await schedule('conversacion-1', at(20));

    expect(await readJob('conversacion-1')).toMatchObject({
      status: 'pending',
      runAt: at(20),
      attempts: 0,
      lastError: null,
    });
  });

  it('la misma clave en otro negocio es otra tarea', async () => {
    const other = await createTenantFixture(db);
    await schedule('misma-clave', at(4));
    await scheduleJob(db, {
      tenantId: other.tenantId,
      kind: 'process_conversation',
      key: 'misma-clave',
      runAt: at(9),
    });

    expect((await readJob('misma-clave')).runAt).toEqual(at(4));
    expect((await readJob('misma-clave', other.tenantId)).runAt).toEqual(at(9));
  });
});

describe('claimJobs: tomar las tareas vencidas', () => {
  it('toma solo las vencidas y las marca en ejecución, con plazo y token de bloqueo', async () => {
    await schedule('vencida', at(0), { conversationId: 'c-1' });
    await schedule('futura', at(10));

    const claimed = await claim(at(5));

    expect(claimed).toEqual([
      {
        id: expect.any(String) as unknown,
        tenantId,
        kind: 'process_conversation',
        key: 'vencida',
        payload: { conversationId: 'c-1' },
        attempts: 1,
        lockToken: expect.any(String) as unknown,
      },
    ]);
    expect(await readJob('vencida')).toMatchObject({
      status: 'running',
      lockedUntil: new Date(at(5).getTime() + LEASE_MS),
    });
    expect((await readJob('futura')).status).toBe('pending');
  });

  it('toma primero las más atrasadas y respeta el límite', async () => {
    await schedule('segunda', at(3));
    await schedule('primera', at(1));
    await schedule('tercera', at(4));

    const claimed = await claim(at(5), 2);

    expect(claimed.map((job) => job.key).sort()).toEqual(['primera', 'segunda']);
  });

  it('no entrega la misma tarea a dos llamadas simultáneas', async () => {
    const keys = ['a', 'b', 'c', 'd', 'e'];
    for (const key of keys) await schedule(key, at(0));

    const [first, second] = await Promise.all([claim(at(1), 3), claim(at(1), 3)]);
    const claimedKeys = [...first, ...second].map((job) => job.key);

    expect(claimedKeys.sort()).toEqual(keys);
  });

  it('una tarea en ejecución no se vuelve a tomar mientras dure su plazo', async () => {
    await schedule('conversacion-1', at(0));
    await claimOne(at(0));

    expect(await claim(at(60))).toEqual([]);
  });

  it('si vence el plazo sin terminar, se vuelve a tomar y cuenta como un intento', async () => {
    await schedule('conversacion-1', at(0));
    const first = await claimOne(at(0));

    const second = await claimOne(new Date(at(0).getTime() + LEASE_MS));

    expect(second).toMatchObject({ key: 'conversacion-1', attempts: 2 });
    expect(second.lockToken).not.toBe(first.lockToken);
    expect((await readJob('conversacion-1')).lastError).toBe(EXPIRED_LEASE_ERROR);
  });

  it('si vence el plazo del último intento, la tarea queda fallida', async () => {
    await schedule('conversacion-1', at(0));
    let now = at(0);
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      expect((await claimOne(now)).attempts).toBe(attempt);
      now = new Date(now.getTime() + LEASE_MS);
    }

    expect(await claim(now)).toEqual([]);
    expect(await readJob('conversacion-1')).toMatchObject({
      status: 'failed',
      lastError: EXPIRED_LEASE_ERROR,
      lockToken: null,
      lockedUntil: null,
    });
  });

  it('sin tipos de tarea para ejecutar no toma nada', async () => {
    await schedule('conversacion-1', at(0));

    const claimed = await claimJobs(db, {
      kinds: [],
      limit: 10,
      now: at(5),
      leaseMs: LEASE_MS,
      maxAttempts: MAX_ATTEMPTS,
    });

    expect(claimed).toEqual([]);
    expect((await readJob('conversacion-1')).status).toBe('pending');
  });
});

describe('completeJob: cerrar una tarea que terminó bien', () => {
  it('la deja terminada y suelta el bloqueo', async () => {
    await schedule('conversacion-1', at(0));
    const job = await claimOne(at(0));

    expect(await completeJob(db, job)).toBe(true);
    expect(await readJob('conversacion-1')).toMatchObject({
      status: 'done',
      lockedUntil: null,
      lockToken: null,
    });
  });

  it('si se programó mientras corría, queda pendiente para esa hora: es la próxima vuelta', async () => {
    await schedule('conversacion-1', at(0));
    const job = await claimOne(at(0));
    await schedule('conversacion-1', at(10));

    await completeJob(db, job);

    expect(await readJob('conversacion-1')).toMatchObject({
      status: 'pending',
      runAt: at(10),
      rerunAt: null,
      attempts: 0,
      lockToken: null,
    });
  });

  it('con un token viejo no la toca: otro worker ya la había vuelto a tomar', async () => {
    await schedule('conversacion-1', at(0));
    const stale = await claimOne(at(0));
    const current = await claimOne(new Date(at(0).getTime() + LEASE_MS));

    expect(await completeJob(db, stale)).toBe(false);
    expect(await readJob('conversacion-1')).toMatchObject({
      status: 'running',
      lockToken: current.lockToken,
    });
  });
});

describe('failJob: registrar un intento fallido', () => {
  it('con reintento, vuelve a pendiente para esa hora y guarda el error', async () => {
    await schedule('conversacion-1', at(0));
    const job = await claimOne(at(0));

    expect(await failJob(db, job, { error: 'Meta respondió 500', retryAt: at(30) })).toBe(true);
    expect(await readJob('conversacion-1')).toMatchObject({
      status: 'pending',
      runAt: at(30),
      attempts: 1,
      lastError: 'Meta respondió 500',
      lockToken: null,
      lockedUntil: null,
    });
  });

  it('sin reintento, queda fallida con el último error', async () => {
    await schedule('conversacion-1', at(0));
    const job = await claimOne(at(0));

    await failJob(db, job, { error: 'Meta respondió 500', retryAt: null });

    expect(await readJob('conversacion-1')).toMatchObject({
      status: 'failed',
      lastError: 'Meta respondió 500',
      lockToken: null,
    });
  });

  it('con reintento y programada mientras corría, vuelve a la hora más cercana', async () => {
    await schedule('conversacion-1', at(0));
    const job = await claimOne(at(0));
    await schedule('conversacion-1', at(8));

    await failJob(db, job, { error: 'Meta respondió 500', retryAt: at(30) });

    expect(await readJob('conversacion-1')).toMatchObject({
      status: 'pending',
      runAt: at(8),
      rerunAt: null,
      attempts: 1,
    });
  });

  it('sin reintento pero programada mientras corría, vuelve a pendiente con los intentos en cero', async () => {
    await schedule('conversacion-1', at(0));
    const job = await claimOne(at(0));
    await schedule('conversacion-1', at(8));

    await failJob(db, job, { error: 'Meta respondió 500', retryAt: null });

    expect(await readJob('conversacion-1')).toMatchObject({
      status: 'pending',
      runAt: at(8),
      rerunAt: null,
      attempts: 0,
      lastError: 'Meta respondió 500',
    });
  });

  it('con un token viejo no la toca', async () => {
    await schedule('conversacion-1', at(0));
    const stale = await claimOne(at(0));
    await claimOne(new Date(at(0).getTime() + LEASE_MS));

    expect(await failJob(db, stale, { error: 'tarde', retryAt: null })).toBe(false);
    expect((await readJob('conversacion-1')).status).toBe('running');
  });

  it('recorta un error muy largo para no llenar la tabla', async () => {
    await schedule('conversacion-1', at(0));
    const job = await claimOne(at(0));

    await failJob(db, job, { error: 'x'.repeat(5_000), retryAt: null });

    expect((await readJob('conversacion-1')).lastError).toHaveLength(1_000);
  });
});
