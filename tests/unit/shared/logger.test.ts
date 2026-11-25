import { Writable } from 'node:stream';
import Anthropic from '@anthropic-ai/sdk';
import { DrizzleQueryError } from 'drizzle-orm';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { WhatsAppApiError } from '../../../src/modules/whatsapp/client.js';
import { buildServer } from '../../../src/server.js';
import { createLogger, safeErrorMessage, serializeError } from '../../../src/shared/logger.js';

const VERIFY_TOKEN = 'token-de-verificacion-que-no-se-loguea';

// Datos de una clienta que nunca pueden llegar al log (10.1 y regla 8).
const PHONE = '+5492615550101';
const NAME = 'Lucía Fernández';
const MESSAGE_TEXT = 'hola, quería saber si tienen turno el viernes';
const TENANT_ID = '0f8b3c2e-6a51-4d4e-9b3f-2c1d0e9a8b7c';

/** El error que devuelve Postgres al repetir el teléfono de una clienta, como lo arma `pg`. */
function uniqueViolation(): pg.DatabaseError {
  const error = new pg.DatabaseError(
    'duplicate key value violates unique constraint "customers_tenant_phone_unique"',
    180,
    'error',
  );
  error.severity = 'ERROR';
  error.code = '23505';
  error.detail = `Key (tenant_id, phone)=(${TENANT_ID}, ${PHONE}) already exists.`;
  error.where = `SQL statement "insert into customers values ('${NAME}')"`;
  error.internalQuery = `select '${NAME}'`;
  error.schema = 'public';
  error.table = 'customers';
  error.constraint = 'customers_tenant_phone_unique';
  return error;
}

/** Lo que tira Drizzle cuando falla un insert: la consulta y los parámetros, en el mensaje. */
function failedInsert(): DrizzleQueryError {
  return new DrizzleQueryError(
    'insert into "customers" ("tenant_id", "phone", "name") values ($1, $2, $3)',
    [TENANT_ID, PHONE, NAME],
    uniqueViolation(),
  );
}

function expectNoCustomerData(text: string) {
  expect(text).not.toContain(PHONE);
  expect(text).not.toContain(NAME);
  expect(text).not.toContain(MESSAGE_TEXT);
  expect(text).not.toContain('insert into');
}

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      lines.push(chunk.toString());
      done();
    },
  });
  return { lines, stream };
}

describe('createLogger', () => {
  it('no guarda el query string de las URLs: la verificación de Meta trae el token ahí', async () => {
    const { lines, stream } = capture();
    const server = buildServer({
      healthChecks: {},
      logger: createLogger({ logLevel: 'info' }, stream),
      whatsappWebhook: { appSecret: 'secreto', verifyToken: VERIFY_TOKEN, onEvents: () => Promise.resolve() },
    });

    const response = await server.inject({
      method: 'GET',
      url: `/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=42`,
    });
    await server.close();

    expect(response.body).toBe('42');
    const log = lines.join('');
    expect(log).toContain('"url":"/webhooks/whatsapp"');
    expect(log).not.toContain(VERIFY_TOKEN);
  });

  it('tampoco guarda el header de autorización', async () => {
    const { lines, stream } = capture();
    const server = buildServer({ healthChecks: {}, logger: createLogger({ logLevel: 'info' }, stream) });

    await server.inject({ method: 'GET', url: '/no-existe', headers: { authorization: 'Bearer EAAG-secreto' } });
    await server.close();

    expect(lines.join('')).not.toContain('EAAG-secreto');
  });
});

describe('serializeError', () => {
  it('saca la consulta y los parámetros de un error de Drizzle, y conserva el tipo y el stack', () => {
    const serialized = serializeError(failedInsert());

    expectNoCustomerData(JSON.stringify(serialized));
    expect(serialized).toMatchObject({ type: 'DrizzleQueryError', message: 'Failed query' });
    expect(serialized).not.toHaveProperty('query');
    expect(serialized).not.toHaveProperty('params');
    expect(serialized.stack).toMatch(/^DrizzleQueryError: Failed query\n\s+at /);
  });

  it('del error de Postgres en la causa conserva el código y la restricción, sin el detalle', () => {
    const { cause } = serializeError(failedInsert());

    expect(cause).toMatchObject({
      type: 'DatabaseError',
      message: 'duplicate key value violates unique constraint "customers_tenant_phone_unique"',
      code: '23505',
      severity: 'ERROR',
      table: 'customers',
      constraint: 'customers_tenant_phone_unique',
    });
    expect(cause).not.toHaveProperty('detail');
    expect(cause).not.toHaveProperty('where');
    expect(cause).not.toHaveProperty('internalQuery');
  });

  it('limpia un error de pg suelto, como el del pool', () => {
    const serialized = serializeError(uniqueViolation());

    expectNoCustomerData(JSON.stringify(serialized));
    expect(serialized).toMatchObject({ type: 'DatabaseError', code: '23505' });
    expect(serialized.stack).toContain('    at ');
  });

  it('limpia un error de Drizzle aunque venga envuelto en la causa de otro', () => {
    const wrapped = new Error('No se pudo guardar el mensaje', { cause: failedInsert() });

    const serialized = serializeError(wrapped);

    expectNoCustomerData(JSON.stringify(serialized));
    expect(serialized).toMatchObject({
      type: 'Error',
      message: 'No se pudo guardar el mensaje',
      cause: { type: 'DrizzleQueryError', cause: { code: '23505' } },
    });
  });

  it('de un error de la API de Anthropic deja el estado y el id del pedido, sin el cuerpo', () => {
    const body = { type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long' } };
    const error = new Anthropic.BadRequestError(400, body, undefined, new Headers({ 'request-id': 'req_123' }));
    // El cuerpo y los headers van en propiedades del error: que no salgan aunque traigan texto.
    Object.assign(body, { echoed: MESSAGE_TEXT });

    const serialized = serializeError(error);

    expectNoCustomerData(JSON.stringify(serialized));
    expect(serialized).toMatchObject({ type: 'BadRequestError', status: 400, requestID: 'req_123' });
    expect(serialized).not.toHaveProperty('error');
    expect(serialized).not.toHaveProperty('headers');
  });

  it('de un error de Meta conserva el estado y el código', () => {
    const error = new WhatsAppApiError('Meta rechazó el mensaje: Re-engagement message', 400, 131047);

    expect(serializeError(error)).toMatchObject({
      type: 'WhatsAppApiError',
      message: 'Meta rechazó el mensaje: Re-engagement message',
      status: 400,
      code: 131047,
    });
  });

  it('serializa los errores de un AggregateError, como el de una conexión rechazada', () => {
    const error = new AggregateError([uniqueViolation(), new Error('connect ECONNREFUSED')], 'Fallaron las conexiones');

    const serialized = serializeError(error);

    expectNoCustomerData(JSON.stringify(serialized));
    expect(serialized.errors).toMatchObject([{ code: '23505' }, { message: 'connect ECONNREFUSED' }]);
  });

  it('deja pasar lo que no es un error', () => {
    expect(serializeError('se cortó')).toBe('se cortó');
  });
});

describe('safeErrorMessage', () => {
  it('de un error de Drizzle deja «Failed query» y el motivo de Postgres, sin la consulta ni los datos', () => {
    const message = safeErrorMessage(failedInsert());

    expect(message).toBe('Failed query: duplicate key value violates unique constraint "customers_tenant_phone_unique"');
    expectNoCustomerData(message);
  });

  it('encadena las causas con el mismo criterio', () => {
    const wrapped = new Error('No se pudo guardar el mensaje', { cause: failedInsert() });

    expect(safeErrorMessage(wrapped)).toBe(
      'No se pudo guardar el mensaje: Failed query: duplicate key value violates unique constraint "customers_tenant_phone_unique"',
    );
  });

  it('un error sin causa queda con su mensaje', () => {
    expect(safeErrorMessage(new Error('Meta no responde'))).toBe('Meta no responde');
  });

  it('lo que no es un error se pasa a texto', () => {
    expect(safeErrorMessage('se cortó')).toBe('se cortó');
  });
});

describe('createLogger con errores', () => {
  it('no deja datos de la clienta en el log cuando falla una consulta', () => {
    const { lines, stream } = capture();

    createLogger({ logLevel: 'info' }, stream).error({ err: failedInsert() }, 'Falló una tarea programada');

    const log = lines.join('');
    expectNoCustomerData(log);
    expect(log).toContain('"code":"23505"');
  });

  it('tampoco en los errores que loguea Fastify, como el de un chequeo de salud', async () => {
    const { lines, stream } = capture();
    const server = buildServer({
      healthChecks: { database: () => Promise.reject(failedInsert()) },
      logger: createLogger({ logLevel: 'info' }, stream),
    });

    const response = await server.inject({ method: 'GET', url: '/health' });
    await server.close();

    expect(response.statusCode).toBe(503);
    const log = lines.join('');
    expectNoCustomerData(log);
    expect(log).toContain('"constraint":"customers_tenant_phone_unique"');
  });
});
