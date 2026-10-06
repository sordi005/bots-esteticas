import { setTimeout as sleep } from 'node:timers/promises';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { scheduleJob, type ClaimedJob } from '../../src/modules/jobs/queue.js';
import {
  createJobRunner,
  type JobHandler,
  type JobRunnerOptions,
} from '../../src/modules/jobs/runner.js';
import { scheduledJobs } from '../../src/modules/jobs/schema.js';
import { createDatabase } from '../../src/shared/db.js';
import { createLogger } from '../../src/shared/logger.js';
import { testDatabaseUrl } from './support/database.js';
import { createTenantFixture, single } from './support/fixtures.js';

const database = createDatabase(testDatabaseUrl());
const { db } = database;
const logger = createLogger({ logLevel: 'silent' });

afterAll(() => database.close());

let tenantId: string;

// La cola es una sola para todos los negocios: cada test arranca sin tareas.
beforeEach(async () => {
  await db.delete(scheduledJobs);
  ({ tenantId } = await createTenantFixture(db));
});

/** Un reloj que el test mueve a mano. */
function fakeClock() {
  let current = new Date('2026-10-06T15:00:00.000Z');
  return {
    now: () => current,
    set: (instant: Date) => {
      current = instant;
    },
    later: (ms: number) => new Date(current.getTime() + ms),
  };
}

/** Una promesa que el test resuelve cuando quiere: sirve para frenar un handler. */
function gate() {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

function schedule(key: string, runAt: Date, payload: Record<string, unknown> = {}) {
  return scheduleJob(db, { tenantId, kind: 'process_conversation', key, payload, runAt });
}

async function readJob(key: string) {
  return single(
    await db
      .select()
      .from(scheduledJobs)
      .where(and(eq(scheduledJobs.tenantId, tenantId), eq(scheduledJobs.key, key))),
  );
}

function runner(handler: JobHandler | undefined, options: Partial<JobRunnerOptions> = {}) {
  const created = createJobRunner({
    db,
    logger,
    handlers: handler ? { process_conversation: handler } : {},
    ...options,
  });
  onTestFinished(() => created.stop());
  return created;
}

describe('runOnce: una vuelta del worker', () => {
  it('ejecuta la tarea vencida con su handler y la deja terminada', async () => {
    const clock = fakeClock();
    await schedule('conversacion-1', clock.now(), { conversationId: 'c-1' });
    const seen: ClaimedJob[] = [];

    await runner(
      (job) => {
        seen.push(job);
        return Promise.resolve();
      },
      { now: clock.now },
    ).runOnce();

    expect(seen).toEqual([
      expect.objectContaining({ key: 'conversacion-1', payload: { conversationId: 'c-1' }, attempts: 1 }),
    ]);
    expect((await readJob('conversacion-1')).status).toBe('done');
  });

  it('si el handler falla, guarda el error y la reintenta a los 30 segundos', async () => {
    const clock = fakeClock();
    await schedule('conversacion-1', clock.now());

    await runner(() => Promise.reject(new Error('Meta no responde')), { now: clock.now }).runOnce();

    expect(await readJob('conversacion-1')).toMatchObject({
      status: 'pending',
      attempts: 1,
      lastError: 'Meta no responde',
      runAt: clock.later(30_000),
    });
  });

  it('después del tercer intento fallido la tarea queda fallida', async () => {
    const clock = fakeClock();
    await schedule('conversacion-1', clock.now());
    const failing = runner(() => Promise.reject(new Error('Meta no responde')), { now: clock.now });

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await failing.runOnce();
      clock.set((await readJob('conversacion-1')).runAt);
    }

    expect(await readJob('conversacion-1')).toMatchObject({
      status: 'failed',
      attempts: 3,
      lastError: 'Meta no responde',
    });
  });

  it('una tarea que no termina a tiempo cuenta como un fallo, y su señal se cancela', async () => {
    const clock = fakeClock();
    await schedule('conversacion-1', clock.now());
    let signalAborted = false;
    const slow: JobHandler = async (_job, { signal }) => {
      signal.addEventListener('abort', () => {
        signalAborted = true;
      });
      await sleep(1_000); // Ignora la señal: el worker igual no la espera.
    };

    await runner(slow, { now: clock.now, timeoutMs: 50 }).runOnce();

    expect(signalAborted).toBe(true);
    expect(await readJob('conversacion-1')).toMatchObject({
      status: 'pending',
      lastError: 'No terminó dentro de los 50 ms',
    });
  });

  it('solo toma los tipos de tarea que sabe ejecutar', async () => {
    const clock = fakeClock();
    await schedule('conversacion-1', clock.now());

    await runner(undefined, { now: clock.now }).runOnce();

    expect((await readJob('conversacion-1')).status).toBe('pending');
  });

  it('no ejecuta más tareas a la vez que su máximo', async () => {
    const clock = fakeClock();
    for (const key of ['a', 'b', 'c']) await schedule(key, clock.now());
    const release = gate();
    let started = 0;
    const worker = runner(
      async () => {
        started += 1;
        await release.opened;
      },
      { now: clock.now, concurrency: 2 },
    );

    const run = worker.runOnce();
    await vi.waitFor(() => {
      expect(started).toBe(2);
    });
    const statuses = await db.select({ status: scheduledJobs.status }).from(scheduledJobs);
    release.open();
    await run;

    expect(statuses.map((row) => row.status).sort()).toEqual(['pending', 'running', 'running']);
  });

  it('nunca corre dos veces la misma tarea a la vez: lo que llega mientras corre va a la próxima vuelta', async () => {
    const clock = fakeClock();
    await schedule('conversacion-1', clock.now());
    const firstRun = gate();
    let runs = 0;
    let active = 0;
    let maxActive = 0;
    const handler: JobHandler = async () => {
      runs += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (runs === 1) await firstRun.opened;
      active -= 1;
    };
    const worker = runner(handler, { now: clock.now });

    const first = worker.runOnce();
    await vi.waitFor(() => {
      expect(runs).toBe(1);
    });
    // Llega otro mensaje mientras corre, y otro worker busca tareas: no la toma.
    await schedule('conversacion-1', clock.now());
    await runner(handler, { now: clock.now }).runOnce();
    expect(runs).toBe(1);

    firstRun.open();
    await first;
    await worker.runOnce();

    expect(runs).toBe(2);
    expect(maxActive).toBe(1);
    expect((await readJob('conversacion-1')).status).toBe('done');
  });
});

describe('start y stop: la vuelta continua', () => {
  it('toma las tareas solo, sin que nadie lo llame', async () => {
    const worker = runner(() => Promise.resolve(), { pollIntervalMs: 10 });
    worker.start();

    await schedule('conversacion-1', new Date());

    await vi.waitFor(async () => {
      expect((await readJob('conversacion-1')).status).toBe('done');
    });
  });

  it('al apagarse espera las tareas en curso y deja de tomar nuevas', async () => {
    const release = gate();
    let runs = 0;
    const worker = runner(
      async () => {
        runs += 1;
        await release.opened;
      },
      { pollIntervalMs: 10 },
    );
    worker.start();
    await schedule('primera', new Date());
    await vi.waitFor(() => {
      expect(runs).toBe(1);
    });

    let stopped = false;
    const stopping = worker.stop().then(() => {
      stopped = true;
    });
    await sleep(50);
    expect(stopped).toBe(false);

    release.open();
    await stopping;
    expect((await readJob('primera')).status).toBe('done');

    await schedule('segunda', new Date());
    await sleep(50);
    expect((await readJob('segunda')).status).toBe('pending');
    expect(runs).toBe(1);
  });
});

describe('check: la salud del worker en /health (sección 10.2)', () => {
  it('está sano mientras completa vueltas', async () => {
    const worker = runner(() => Promise.resolve(), { pollIntervalMs: 10 });
    worker.start();

    await expect(worker.check()).resolves.toBeUndefined();
  });

  it('deja de estar sano si no completa una vuelta en 30 segundos', async () => {
    const clock = fakeClock();
    await schedule('conversacion-1', clock.now());
    // Una vuelta por hora: después de la primera, el worker queda dormido.
    const worker = runner(() => Promise.resolve(), { now: clock.now, pollIntervalMs: 3_600_000 });
    worker.start();
    await vi.waitFor(async () => {
      expect((await readJob('conversacion-1')).status).toBe('done');
    });

    clock.set(clock.later(29_000));
    await expect(worker.check()).resolves.toBeUndefined();

    clock.set(clock.later(2_000));
    await expect(worker.check()).rejects.toThrow('no completó una vuelta');
  });

  it('no está sano si no arrancó o si ya se apagó', async () => {
    const worker = runner(() => Promise.resolve(), { pollIntervalMs: 10 });
    await expect(worker.check()).rejects.toThrow('no está corriendo');

    worker.start();
    await worker.stop();

    await expect(worker.check()).rejects.toThrow('no está corriendo');
  });
});
