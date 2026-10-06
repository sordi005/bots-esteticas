## Qué entra

<!-- Hito (H#) o motivo del cambio, en una o dos oraciones. -->

## Cambios

<!-- Lo importante, agrupado. Sin repetir cada commit. -->

## Reglas de la especificación

<!-- Secciones de docs/SPEC.md que aplica. Las [S] que se resolvieron y con qué valor. Las [?] que bloquean, si hay. -->

## Cómo se verificó

- [ ] `pnpm check` en verde (lint, tipos, unitarios, contratos e integración)
- [ ] Tests nuevos escritos antes del código (rojo → verde)
- [ ] Si agrega tablas: test de aislamiento entre negocios
- [ ] Si cambia un `schema.ts`: migración generada y commiteada
- [ ] Si toca el agente, un prompt o una herramienta: evaluaciones de `tests/evals/`
- [ ] Prueba manual, si el criterio del hito la pide

## Pendientes

<!-- Lo que queda para otro hito, con el hito. -->
