# CLAUDE.md

Asistente de WhatsApp con IA para centros de estética de Mendoza, ofrecido como servicio gestionado a varios negocios desde una sola instancia.

## Antes de tocar código

- La especificación completa está en `docs/SPEC.md`. **Es la fuente de verdad.** Leé las secciones que afecten a la tarea antes de empezar.
- Las reglas marcadas **[D]** se implementan tal cual. Las **[S]** también, pero dejá el valor configurable. Las **[?]** no se implementan: si una tarea depende de una, frená y preguntá.
- Si encontrás una contradicción o un hueco en la especificación, no lo resuelvas por tu cuenta en el código. Proponé el cambio al documento y esperá confirmación.
- Trabajamos por hitos (sección 13 de la especificación). Un hito por vez. No adelantes trabajo de hitos futuros.

## Stack

TypeScript estricto · Node.js LTS · Fastify · PostgreSQL · Drizzle ORM (migraciones SQL) · Zod · Vitest · Pino · Docker Compose para desarrollo.

No agregar dependencias fuera de esta lista sin proponerlo primero y explicar por qué.

## Comandos

Se completan en el hito H1.

```
# instalar, levantar Postgres, migrar, correr tests, lint, typecheck, dev
```

## Estructura

```
src/
  modules/
    tenants/  catalog/  scheduling/  customers/  payments/
    whatsapp/  conversation/  notifications/  calendar/
    jobs/  reporting/  admin/
  shared/        # config, db, logger, errores, utilidades de fechas
  server.ts      # arma Fastify y registra rutas
  worker.ts      # loop de tareas programadas
tests/
  unit/  integration/  contracts/  evals/
docs/
  SPEC.md
```

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

## Testing

- Toda lógica de dominio nueva lleva tests unitarios, incluidos los casos borde que lista la sección 11.1 de la especificación.
- Los tests de integración usan Postgres real (Docker), no mocks de la base.
- Si cambiás el agente, un prompt o una herramienta, corré las evaluaciones de `tests/evals/` y reportá el resultado.
- Un hito no está terminado si CI no está en verde.

## Forma de trabajo

- El desarrollador está aprendiendo. Al terminar cada hito, escribí un resumen breve con: qué se hizo, qué patrones o principios se aplicaron y por qué, y qué conceptos conviene estudiar para entenderlo a fondo.
- Preferí la solución más simple que cumpla la especificación. Si creés que algo necesita más complejidad (una cola externa, un cache, otro servicio), justificalo con un requisito concreto antes de agregarlo.
- Commits chicos y descriptivos, en español.
