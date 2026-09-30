# CLAUDE.md

Asistente de WhatsApp con IA para centros de estética de Mendoza, ofrecido como servicio gestionado a varios negocios desde una sola instancia.

## Antes de tocar código

- La especificación completa está en `docs/SPEC.md`. **Es la fuente de verdad.** Leé las secciones que afecten a la tarea antes de empezar.
- Las reglas marcadas **[D]** se implementan tal cual. Las **[S]** también, pero dejá el valor configurable. Las **[?]** no se implementan: si una tarea depende de una, frená y preguntá.
- Si encontrás una contradicción o un hueco en la especificación, no lo resuelvas por tu cuenta en el código. Proponé el cambio al documento y esperá confirmación.
- Trabajamos por hitos (sección 13 de la especificación). Un hito por vez. No adelantes trabajo de hitos futuros.

## Stack

TypeScript estricto · Node.js 22 LTS · Fastify · PostgreSQL 17 · Drizzle ORM (migraciones SQL) · Zod · Vitest · Pino · Docker Compose para desarrollo · pnpm.

Dependencias de soporte aprobadas:

| Paquete | Para qué |
|---|---|
| `pg` | Driver con el que Drizzle habla con Postgres |
| `drizzle-kit` | Genera las migraciones SQL a partir de los schemas |
| `tsx` | Corre TypeScript en desarrollo con recarga (`pnpm dev`) |
| `eslint`, `@eslint/js`, `typescript-eslint` | Lint con reglas que usan los tipos |
| `@types/node`, `@types/pg` | Tipos |

Entran en su hito, según la especificación: SDK de Anthropic (H7) y Sentry (H14).

No agregar dependencias fuera de esta lista sin proponerlo primero y explicar por qué.

### Dependencias y cadena de suministro

- **Siempre pnpm, nunca npm.** La versión está fijada con hash en `packageManager` (`package.json`); Corepack la descarga sola.
- Las protecciones viven en `pnpm-workspace.yaml` y no se relajan sin acordarlo:
  - `allowBuilds`: ninguna dependencia corre scripts de instalación.
  - `minimumReleaseAge`: nada publicado hace menos de 7 días.
  - `trustPolicy: no-downgrade`: falla si una versión nueva tiene menos garantías de procedencia.
- Toda excepción (`allowBuilds: true`, `trustPolicyExclude`) lleva versión exacta y un comentario con el motivo.
- TypeScript queda en 6.0.x: `typescript-eslint` todavía no soporta TypeScript 7.
- CI instala con `--frozen-lockfile` y fija las acciones de GitHub por commit SHA.

## Comandos

```bash
cp .env.example .env      # una sola vez; ajustá PORT si el 3000 está ocupado
pnpm install              # dependencias
pnpm db:up                # Postgres en Docker (puerto 5434), espera a que esté listo
pnpm dev                  # servidor con recarga en http://localhost:$PORT
pnpm check                # lint + tipos + todos los tests (lo mismo que CI)
pnpm test:unit            # solo unitarios (no necesitan base)
pnpm test:integration     # contra Postgres real (necesita db:up)
pnpm lint:fix             # arregla lo que ESLint puede arreglar solo
pnpm build && pnpm start  # compilar a dist/ y correr como en producción
pnpm db:generate          # generar una migración desde los schemas (desde H2)
pnpm db:down              # apagar Postgres (los datos quedan en el volumen)
```

## Estructura

```
src/
  modules/
    tenants/  catalog/  scheduling/  customers/  payments/
    whatsapp/  conversation/  notifications/  calendar/
    jobs/  reporting/  admin/
    # cada módulo declara sus tablas en su schema.ts (desde H2)
  shared/        # config, db, logger, health, errores, utilidades de fechas
  server.ts      # arma Fastify y registra rutas (no escucha: se testea con inject)
  main.ts        # punto de entrada: config, base, listen y apagado ordenado
  worker.ts      # loop de tareas programadas (H6)
migrations/      # SQL generado por drizzle-kit (desde H2)
tests/
  unit/  integration/  contracts/  evals/
docker/          # scripts de inicio de Postgres (crea la base de tests)
docs/
  SPEC.md
```

Imports relativos con extensión `.js` aunque el archivo sea `.ts`: es ESM de Node (`module: nodenext`), y el código compilado en `dist/` necesita la ruta real.

## Reglas no negociables

1. **Multi-negocio:** toda tabla de negocio tiene `tenant_id` y toda consulta filtra por él. Cada hito que agregue tablas agrega un test de aislamiento.
2. **La IA elige, el código decide:** precios, horarios, disponibilidad y estados salen siempre de la base. El modelo solo llama herramientas; las herramientas validan todo con Zod y reciben `tenant_id` y `customer_id` del contexto del servidor, nunca como parámetro del modelo.
3. **Dominio sin infraestructura:** `scheduling`, `catalog`, `customers` y `payments` no importan nada de WhatsApp, Fastify ni del SDK de IA. La disponibilidad es una función pura.
4. **Máquina de estados única:** las transiciones de turnos se definen en un solo archivo. Toda transición registra un evento de auditoría.
5. **Fechas:** `timestamptz` en UTC en la base; se convierten a `America/Argentina/Mendoza` solo al mostrar. Nada de `new Date()` suelto en la lógica de dominio: la hora actual se inyecta, para poder testear.
6. **Webhooks:** validar firma, guardar, responder 200 y procesar en el worker. Idempotentes por id de mensaje o de pago.
7. **Tareas programadas idempotentes:** antes de actuar, verificar que la acción siga siendo válida.
8. **Secretos:** nunca en código ni en logs. Credenciales de terceros cifradas en la base.
9. **Sin datos de salud:** no se agregan campos ni extracción de datos de salud de las clientas.
10. **Idioma:** identificadores en inglés; textos que ven clientas y dueñas en español rioplatense.

ESLint hace cumplir las reglas 3 y 5 en `src/modules/{scheduling,catalog,customers,payments}`: bloquea imports de Fastify, del SDK de IA y de `whatsapp`/`conversation`/`notifications`, y bloquea `new Date()` sin argumentos y `Date.now()`. Si una regla del lint molesta, se discute; no se desactiva con un comentario.

## Testing

- Toda lógica de dominio nueva lleva tests unitarios, incluidos los casos borde que lista la sección 11.1 de la especificación.
- Los tests de integración usan Postgres real (Docker), no mocks de la base.
- Si cambiás el agente, un prompt o una herramienta, corré las evaluaciones de `tests/evals/` y reportá el resultado.
- Un hito no está terminado si CI no está en verde. Antes de cada commit: `pnpm check`.
- Los tests de integración leen `TEST_DATABASE_URL` (base `bots_esteticas_test`, separada de la de desarrollo).

## Forma de trabajo

- El desarrollador está aprendiendo. Al terminar cada hito, escribí un resumen breve con: qué se hizo, qué patrones o principios se aplicaron y por qué, y qué conceptos conviene estudiar para entenderlo a fondo.
- Preferí la solución más simple que cumpla la especificación. Si creés que algo necesita más complejidad (una cola externa, un cache, otro servicio), justificalo con un requisito concreto antes de agregarlo.
- Commits chicos y descriptivos, en español.
