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
pnpm db:migrate           # aplica las migraciones pendientes
pnpm db:seed              # carga o restaura "Estética Ejemplo"
pnpm dev                  # servidor + worker con recarga en http://localhost:$PORT
                          # en desarrollo, el worker contesta con el agente si hay ANTHROPIC_API_KEY en .env
pnpm check                # lint + tipos + todos los tests (lo mismo que CI)
pnpm test:unit            # solo unitarios (no necesitan base)
pnpm test:integration     # contra Postgres real (necesita db:up)
pnpm test:contracts       # parsers contra ejemplos reales de Meta (sin red ni base)
pnpm lint:fix             # arregla lo que ESLint puede arreglar solo
pnpm build && pnpm start  # compilar a dist/ y correr como en producción
pnpm db:generate          # después de cambiar un schema.ts: genera la migración SQL
pnpm db:reset             # borra la base de desarrollo y la rearma (migrate + seed)
pnpm db:down              # apagar Postgres (los datos quedan en el volumen)
pnpm whatsapp:connect <negocio>  # guarda número y token de WhatsApp (los lee de .env), cifrado
```

Para probar con el número de prueba de Meta y un celular argentino, poné en `.env` `WHATSAPP_TEST_RECIPIENT` con el número como figura en la lista de permitidos (con el 15): todo envío va ahí (sección 8.1).

Para que Meta llegue al servidor local hace falta el túnel de ngrok, en una terminal aparte y con el `PORT` de tu `.env` (el dominio es fijo y ya está registrado en Meta):

```bash
ngrok http 3100 --url=overfull-subsector-tubby.ngrok-free.dev
```

Después de reiniciar la PC no hay túnel y Docker Desktop no arranca solo: abrí Docker, `pnpm db:up` y el túnel antes de `pnpm dev`. Si el bot no contesta, seguí el mensaje: ¿llegó a `messages`? ¿tiene tarea en `scheduled_jobs`? ¿la tarea tiene `last_error`?

El token de WhatsApp vive cifrado en la base, no en `.env`: cambiar `WHATSAPP_ACCESS_TOKEN` en `.env` no alcanza. Después de cambiarlo, corré `pnpm whatsapp:connect estetica-ejemplo` para guardarlo.

En producción, con el código compilado: `node dist/migrate.js` y, para la demo, `node dist/seed.js`.

## Estructura

```
src/
  modules/
    tenants/  catalog/  scheduling/  customers/  payments/
    whatsapp/  conversation/  notifications/  calendar/
    jobs/  reporting/  admin/
    # cada módulo declara sus tablas en su schema.ts
  shared/        # config, db, columnas comunes, migraciones, logger, health, zonas horarias
  seeds/         # datos de ejemplo ("Estética Ejemplo")
  cli/           # herramientas de línea de comandos (conectar WhatsApp)
  server.ts      # arma Fastify y registra rutas (no escucha: se testea con inject)
  main.ts        # punto de entrada: config, base, listen y apagado ordenado
  migrate.ts     # punto de entrada: aplica las migraciones
  seed.ts        # punto de entrada: carga los datos de ejemplo
  worker.ts      # arma el worker de tareas programadas con un handler por tipo (no arranca)
migrations/      # SQL generado por drizzle-kit; nunca se edita a mano
tests/
  unit/  integration/  contracts/  evals/
  # contracts/whatsapp/: ejemplos oficiales de Meta, copiados tal cual
docker/          # scripts de inicio de Postgres (crea la base de tests)
docs/
  SPEC.md
```

Imports relativos con extensión `.js` aunque el archivo sea `.ts`: es ESM de Node (`module: nodenext`), y el código compilado en `dist/` necesita la ruta real.

## Base de datos

Las convenciones completas están en la sección 7.1 de la especificación. Las que más se olvidan:

- Toda tabla de negocio nueva lleva `tenantId()` (de `modules/tenants/schema.ts`), `unique(tenant_id, id)` si otras tablas la referencian, y claves foráneas compuestas `(tenant_id, id_padre)` hacia sus padres. `tests/integration/tenant-isolation.test.ts` lo verifica solo sobre todas las tablas.
- Dinero en centavos (`integer`, nombre terminado en `Cents`). Instantes con `instant()`, rangos con `timestampRange()`, ambos de `shared/db-columns.ts`.
- Después de cambiar un `schema.ts`: `pnpm db:generate` y commitear la migración junto con el cambio. Una migración ya mergeada no se edita: los cambios van en una nueva. CI falla si falta una migración.
- Feriados: cada año, una migración de datos nueva (`drizzle-kit generate --custom`) con la lista oficial de argentina.gob.ar/feriados y la fuente citada en el SQL. Nunca fechas no publicadas.

## Fechas y dominio

- La lógica de dominio es pura: recibe la hora actual (`now`) y la zona horaria del negocio por parámetro.
- Un `Date` leído de Postgres pierde los microsegundos: nunca lo uses como cursor de `created_at > cursor`, porque la última fila vuelve para siempre. Usá el valor como texto de Postgres (`created_at::text`) o un id.
- Toda conversión entre hora local e instante pasa por `shared/time-zone.ts`. Nunca sumes horas a mano para "pasar a Mendoza": con horario de verano en otra zona, eso da mal.
- Estados y transiciones de turnos: solo en `modules/scheduling/appointment-state-machine.ts`. El esquema de la base importa los estados de ahí.
- Reservar, cambiar el estado o reprogramar un turno: solo con las funciones de `modules/scheduling/booking.ts`, nunca con un insert o update directo a `appointments`. Ahí se valida todo contra la base y se registra el evento de auditoría en la misma transacción.
- La restricción `appointments_no_overlap` vive en la migración 0003 (Drizzle no sabe declararla). Si cambian los estados que ocupan el horario, va una migración nueva; el test `appointment-overlap` avisa si quedaron distintos.

## WhatsApp

- El webhook solo valida la firma, guarda y responde: nunca contesta ni llama a la IA (regla 6). Al guardar un mensaje nuevo, el inbox programa la vuelta de su conversación; contestar es del worker.
- Los formatos de Meta se toman de la documentación oficial, no de memoria. Un tipo de mensaje nuevo entra con su ejemplo oficial en `tests/contracts/whatsapp/`.
- Para enviar: `sendWhatsAppMessage` de `modules/conversation/outbox.ts`. Valida los límites de Meta, usa el token cifrado del negocio y registra el mensaje.
- Credenciales de terceros: solo con `saveCredential` / `loadCredential` de `modules/tenants/credentials.ts`. Nunca en logs. El contenido de los mensajes tampoco va en logs de nivel info (sección 10.1).
- Los logs de pedidos guardan la ruta sin query string ni headers (`shared/logger.ts`): Meta manda el token de verificación en la URL.
- Probar con Meta: el webhook necesita la suscripción de la app **y** la de la cuenta del negocio (sección 8.1). Si "verifica pero no llega nada", revisar las dos por API antes de tocar código.

## Tareas programadas

El detalle está en la sección 6.7 de la especificación.

- Programar algo: solo con `scheduleJob` de `modules/jobs/queue.ts`. Hay una fila por negocio, tipo y clave: programar de nuevo actualiza la fila, nunca crea otra. Elegí la clave para que una tarea repetida sea la misma fila (la de una conversación es su id).
- Si se programa algo junto con otro cambio, hacelo en la misma transacción (el inbox programa la conversación al guardar el mensaje).
- Un tipo de tarea nuevo: valor en el enum `job_kind` (con su migración) y su handler en `src/worker.ts`. El worker solo toma los tipos que tienen handler.
- Un handler puede correr más de una vez (reintentos, plazo vencido): antes de actuar, verifica que la acción siga siendo válida (regla 7). Recibe un `signal` que se cancela a los 60 s.
- La cola recibe la hora por parámetro: en los tests se mueve el reloj, no se espera.
- Los tests que toman tareas borran `scheduled_jobs` en `beforeEach`: la cola es una sola para todos los negocios y un claim tomaría las de otro test.

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
- Los tests de integración leen `TEST_DATABASE_URL` (base `bots_esteticas_test`, separada de la de desarrollo). Arrancan con la base vacía y migrada; cada test crea sus datos con `createTenantFixture` (slugs aleatorios) y no depende del orden de los archivos.
- Para verificar que la base rechaza algo, usá `expectConstraintViolation` con el nombre exacto de la restricción: así el test falla si rechaza por otro motivo.

## Forma de trabajo

- El desarrollador está aprendiendo. Al terminar cada hito, escribí un resumen breve con: qué se hizo, qué patrones o principios se aplicaron y por qué, y qué conceptos conviene estudiar para entenderlo a fondo.
- Preferí la solución más simple que cumpla la especificación. Si creés que algo necesita más complejidad (una cola externa, un cache, otro servicio), justificalo con un requisito concreto antes de agregarlo.
- Commits chicos y descriptivos, en español.

### Git y GitHub

`main` está protegida: solo se entra por Pull Request, con el check de CI ("Lint, tipos, tests y build") en verde y la rama al día con `main`. La regla vale también para administradores. No hay force-push.

- **Ramas:** `hN-tema` para un hito (`h6-jobs`), `fix/tema`, `docs/tema` o `chore/tema` para lo demás. Siempre desde `main` actualizada.
- **Commits:** chicos, en español, con prefijo `feat:`, `fix:`, `test:`, `docs:`, `refactor:` o `chore:`. El título dice qué cambia; el cuerpo, por qué. `pnpm check` antes de cada uno.
- **Pull Request:** uno por hito o por cambio suelto, con la plantilla de `.github/pull_request_template.md`. El título es el del hito (`H6 · Tareas programadas`). Se mergea desde GitHub con merge commit (squash y rebase están desactivados, para conservar los commits chicos); la rama se borra sola.
- **Cierre de un hito**, en este orden:
  1. PR mergeado con CI en verde, y CI en verde también sobre `main`.
  2. Tag anotado `v0.N.0` (N = número de hito) sobre el merge, y release en GitHub con un resumen y la cantidad de tests.
  3. Reporte de avance actualizado (Claude Doc).
  4. Resumen para el desarrollador: qué se hizo, patrones y conceptos para estudiar.
- **Sesiones:** una sesión de Claude Code por hito. Al empezar una sesión nueva, avisarle al desarrollador que es una sesión nueva y qué contexto se recuperó (engram, `SPEC.md`, último tag). Al cerrar un hito, recomendar abrir una sesión nueva para el siguiente.
