# Pull Request

Gracias por contribuir a Numination. Completa todas las secciones aplicables. Los PRs incompletos serán marcados como borrador hasta que la información esté disponible.

> **Antes de enviar:** lee [CONTRIBUTING.md](../CONTRIBUTING.md) y respeta el [Código de Conducta](../CODE_OF_CONDUCT.md).
>
> **Licencia:** al enviar este PR aceptas que tu contribución pasa a ser propiedad exclusiva del titular de Numination, conforme a [`docs/LICENSE.md`](../docs/LICENSE.md).

---

## 1. Descripción del cambio

<!-- Explica qué hace este PR y por qué es necesario. Sé claro y conciso. -->

**Qué:**

**Por qué:**

**Cómo:**

---

## 2. Issue relacionado

<!-- Usa "Closes #123" o "Fixes #123" para cerrar el issue automáticamente. -->

Closes #

**¿Hay un issue o discusión previa?**

- [ ] Sí: #
- [ ] No, es un cambio pequeño y justificado
- [ ] No aplica (documentación o mantenimiento)

---

## 3. Tipo de cambio

Marca todas las que apliquen:

- [ ] 🐛 **Bugfix** — corrige un comportamiento incorrecto sin romper compatibilidad
- [ ] ✨ **Feature** — añade funcionalidad nueva compatible
- [ ] 💥 **Breaking change** — cambia un contrato, ruta, esquema o comportamiento existente
- [ ] 📝 **Documentación** — solo cambios en `docs/`, README o comentarios
- [ ] ♻️ **Refactor** — reestructura código sin cambiar comportamiento
- [ ] ⚡ **Performance** — mejora rendimiento sin cambiar comportamiento
- [ ] ✅ **Tests** — añade o corrige pruebas
- [ ] 🔧 **Chore / tooling** — dependencias, CI, configuración o scripts
- [ ] 🎨 **UI / UX** — cambios visuales o de interacción
- [ ] 🔒 **Seguridad** — mitigación o corrección de seguridad

---

## 4. Cómo se probó

<!-- Describe los comandos, escenarios y datos usados. Adjunta evidencia. -->

### 4.1 Comandos ejecutados

```bash
npm ci
npm test
npm audit --omit=dev
```

**Resultado:**

- [ ] `npm test` pasa en local
- [ ] `npm test` pasa en CI
- [ ] No aplica (solo documentación)

### 4.2 Escenarios verificados

| Escenario | Resultado esperado | Resultado obtenido |
|---|---|---|
| <!-- login con email --> | <!-- sesión creada --> | <!-- OK --> |
| <!-- chat con streaming --> | <!-- tokens en vivo --> | <!-- OK --> |
| <!-- webhook duplicado --> | <!-- no duplica créditos --> | <!-- OK --> |

### 4.3 Evidencia

<!-- Capturas, GIF, logs o salida de tests. Sin secretos ni datos personales. -->

```text
Pega aquí la salida relevante.
```

---

## 5. Checklist obligatorio

- [ ] He leído el [`CONTRIBUTING.md`](../CONTRIBUTING.md).
- [ ] He corrido `npm test` y todos los tests pasan.
- [ ] He añadido tests para el comportamiento nuevo o corregido.
- [ ] No he subido secretos, tokens, contraseñas, `.env` ni `env.local.js`.
- [ ] No he subido datos personales de terceros.
- [ ] He actualizado la documentación si cambió un contrato.
- [ ] He actualizado `.env.example` si añadí variables de entorno.
- [ ] He verificado que no hay `console.log` de depuración.
- [ ] He verificado que no hay `var` en JavaScript nuevo.
- [ ] He verificado que no hay `TODO` sin issue asociado.
- [ ] Mi rama está actualizada con `main`.
- [ ] El PR tiene un alcance único y revisable.
- [ ] Respeté el [Código de Conducta](../CODE_OF_CONDUCT.md).

---

## 6. Seguridad

<!-- Completa esta sección si el PR toca autenticación, autorización, pagos, archivos, webhooks o datos de usuario. -->

- [ ] Toda consulta a recursos con `user_id` filtra por `user_id` en SQL.
- [ ] Las entradas se validan con Zod en el borde.
- [ ] Las salidas dinámicas se escapan antes de `innerHTML`.
- [ ] Las URLs dinámicas se sanean.
- [ ] Los endpoints sensibles tienen rate limiting.
- [ ] Las operaciones de dinero son transaccionales e idempotentes.
- [ ] Los webhooks verifican firma y cuerpo crudo.
- [ ] No se registran secretos ni PII en logs.
- [ ] No aplica (cambio sin superficie de seguridad).

**¿Este PR introduce una nueva dependencia?**

- [ ] No
- [ ] Sí, justificada abajo:

```text
Nombre, versión, licencia, mantenimiento y motivo.
```

**¿Este PR cambia el esquema de base de datos?**

- [ ] No
- [ ] Sí, incluye migración idempotente y plan de rollback:

```text
Describe la migración y cómo revertirla.
```

---

## 7. Breaking changes

<!-- Si marcas "Breaking change" arriba, explica el impacto y la migración. -->

- [ ] No aplica
- [ ] Sí, descrito abajo

**Qué se rompe:**

**Cómo migrar:**

**Versión sugerida:**

- [ ] Patch
- [ ] Minor
- [ ] Major

---

## 8. Plan de rollback

<!-- ¿Cómo se revierte este cambio si falla en producción? -->

```text
Ejemplo: revertir el commit, desplegar la versión anterior, no requiere cambios en DB.
```

---

## 9. Capturas o video (si aplica)

| Antes | Después |
|---|---|
| <!-- captura --> | <!-- captura --> |

---

## 10. Notas para el revisor

<!-- Decisiones de diseño, trade-offs, partes que quieres que se revisen con especial atención. -->

**Áreas de especial atención:**

**Trade-offs conocidos:**

**Seguimiento pendiente (issues futuros):**

---

## 11. Autor

- **Nombre o alias:**
- **GitHub:**
- **¿Deseas aparecer en las notas de la versión?**
  - [ ] Sí
  - [ ] No

---

<!--
Gracias por tu contribución. Un mantenedor revisará el PR en un plazo objetivo de 5 días hábiles.
No etiquetes a revisores para acelerar el proceso: la cola se atiende por orden y severidad.
-->
