import { describe, expect, it } from 'vitest';
import { worktreeDatabaseUrl } from '../integration/support/database.js';

const BASE = 'postgres://usuaria:clave@localhost:5434/bots_esteticas_test?sslmode=disable';

function databaseName(url: string): string {
  return new URL(url).pathname.slice(1);
}

describe('base de tests de cada worktree', () => {
  it('cambia solo el nombre de la base: mismo servidor, usuario y parámetros', () => {
    const url = new URL(worktreeDatabaseUrl(BASE, '/repo/worktrees/uno'));

    expect(url.host).toBe('localhost:5434');
    expect(url.username).toBe('usuaria');
    expect(url.password).toBe('clave');
    expect(url.search).toBe('?sslmode=disable');
    expect(databaseName(url.toString())).toMatch(/^bots_esteticas_[0-9a-f]{8}_test$/);
  });

  it('dos worktrees usan bases distintas', () => {
    const first = databaseName(worktreeDatabaseUrl(BASE, '/repo/worktrees/uno'));
    const second = databaseName(worktreeDatabaseUrl(BASE, '/repo/worktrees/dos'));

    expect(first).not.toBe(second);
  });

  it('el mismo worktree usa siempre la misma, escrita como sea la ruta', () => {
    const expected = worktreeDatabaseUrl(BASE, '/repo/worktrees/uno');

    expect(worktreeDatabaseUrl(BASE, '/repo/worktrees/uno/')).toBe(expected);
    // En Windows la misma carpeta llega con "C:" o "c:" según desde dónde se la abra.
    expect(worktreeDatabaseUrl(BASE, '/Repo/Worktrees/UNO')).toBe(expected);
  });

  it('exige que la base configurada ya termine en "_test"', () => {
    const development = 'postgres://postgres:postgres@localhost:5434/bots_esteticas';

    expect(() => worktreeDatabaseUrl(development, '/repo')).toThrow(/terminada en "_test"/);
  });
});
