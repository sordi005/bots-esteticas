import type { Logger } from 'pino';

export interface FatalErrorDependencies {
  logger: Logger;
  /** Manda el error a Sentry. */
  report: (error: unknown) => void;
  /** Espera a que salga lo pendiente hacia Sentry. */
  flush: () => Promise<unknown>;
  exit: (code: number) => void;
}

export type FatalOrigin = 'uncaughtException' | 'unhandledRejection';

/**
 * Una excepción o una promesa rechazada sin capturar (10.2): el proceso quedó en un estado que nadie
 * previó. Se reporta, se registra como `fatal` y el proceso termina con código 1 para que lo reinicie
 * quien lo supervisa.
 */
export async function handleFatalError(deps: FatalErrorDependencies, error: unknown, origin: FatalOrigin): Promise<void> {
  deps.report(error);
  deps.logger.fatal({ err: error, origin }, 'Error sin capturar: el proceso termina');
  await deps.flush().catch(() => undefined);
  deps.exit(1);
}

/** Registra los manejadores del proceso. Una segunda falla mientras se termina no hace nada más. */
export function installFatalErrorHandlers(deps: FatalErrorDependencies): void {
  let handling = false;
  const handle = (origin: FatalOrigin) => (error: unknown) => {
    if (handling) return;
    handling = true;
    void handleFatalError(deps, error, origin);
  };
  process.on('uncaughtException', handle('uncaughtException'));
  process.on('unhandledRejection', handle('unhandledRejection'));
}
