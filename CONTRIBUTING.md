# Contribuir a Numination

Gracias por tu interés en mejorar Numination. Este documento es la guía oficial para preparar un entorno, escribir código, probarlo y enviar cambios que podamos revisar y aceptar sin fricción.

> **Licencia:** Numination es software propietario. Enviar un Pull Request implica aceptar que el código pasa a ser propiedad exclusiva del titular. Contribuir **no** otorga derechos sobre la obra. Consulta [`docs/LICENSE.md`](docs/LICENSE.md).
>
> **Regla cero:** si no puedes explicar el cambio en una frase, es demasiado grande. Divide el trabajo.

---

## 1. Antes de empezar

| Requisito | Detalle |
|---|---|
| Node.js | **22 o superior** |
| PostgreSQL | **15+** (Supabase recomendado) |
| Git | Configurado con tu nombre y email |
| Entorno | Variables descritas en [`.env.example`](.env.example) |
| Rama base | `main` |
| Tests | Obligatorios para lógica de negocio |
| Código de Conducta | [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) |

### 1.1 Prepara tu entorno

```bash
# 1. Haz fork del repositorio desde la interfaz de GitHub
# 2. Clona tu fork
git clone https://github.com/TU-USUARIO/Numination.git
cd Numination

# 3. Añade el repositorio original como remoto
git remote add upstream https://github.com/trivoren/Numination.git

# 4. Instala dependencias
npm install

# 5. Configura el entorno
cp .env.example env.local.js
# Rellena env.local.js. Nunca lo subas a Git.

# 6. Verifica que el servidor arranca
npm run dev
```

Abre [http://localhost:8080](http://localhost:8080) y comprueba:

```bash
curl -s http://localhost:8080/api/health
```

Si el health check falla, revisa [docs/troubleshooting.md](docs/troubleshooting.md) antes de abrir un issue.

---

## 2. Flujo de Git: Fork → Branch → PR

### 2.1 Mantén tu fork actualizado

```bash
git checkout main
git fetch upstream
git pull upstream main --ff-only
git push origin main
```

### 2.2 Crea una rama descriptiva

```bash
git checkout -b feat/nombre-corto
```

| Prefijo | Uso |
|---|---|
| `feat/` | Nueva funcionalidad |
| `fix/` | Corrección de bug |
| `docs/` | Solo documentación |
| `refactor/` | Cambio interno sin alterar comportamiento |
| `test/` | Solo tests |
| `chore/` | Tooling, dependencias, configuración |
| `hotfix/` | Urgente sobre producción |

Reglas para el nombre:

- Minúsculas y guiones: `fix/rag-hnsw-index`.
- Sin espacios, acentos ni caracteres especiales.
- Máximo 50 caracteres.
- Una rama = un propósito.

### 2.3 Haz commits pequeños y atómicos

Cada commit debe compilar y dejar los tests en verde. No mezcles un refactor con una feature.

```bash
git add archivo.js
git commit -m "fix(rag): crear índice HNSW en rag_chunks"
```

### 2.4 Sincroniza antes del PR

```bash
git fetch upstream
git rebase upstream/main
```

Resuelve conflictos en tu rama, nunca en `main`. Si el rebase ya fue publicado y compartido, usa `git merge upstream/main` en lugar de reescribir historia.

### 2.5 Abre el Pull Request

```bash
git push origin feat/nombre-corto
```

Abre el PR contra `main` de `trivoren/Numination`. Usa el título con el mismo formato del commit principal y completa la plantilla.

---

## 3. Conventional Commits

El historial se lee. Usamos el estándar **Conventional Commits**:

```text
<tipo>(<alcance>): <descripción en imperativo>

[cuerpo opcional]

[footer opcional]
```

### 3.1 Tipos permitidos

| Tipo | Cuándo usarlo |
|---|---|
| `feat` | Nueva funcionalidad visible para el usuario |
| `fix` | Corrección de un bug |
| `docs` | Cambios solo en documentación |
| `style` | Formato, espacios, punto y coma; sin cambio de lógica |
| `refactor` | Reestructuración sin cambiar comportamiento |
| `perf` | Mejora de rendimiento |
| `test` | Añadir o corregir tests |
| `build` | Sistema de build o dependencias |
| `ci` | Configuración de integración continua |
| `chore` | Tareas de mantenimiento que no encajan arriba |
| `revert` | Revertir un commit anterior |

### 3.2 Ejemplos correctos

```text
feat(payments): otorgar créditos desde el catálogo en webhook
fix(rag): crear índice HNSW en rag_chunks
docs(api): documentar /api/coder/execute
refactor(auth): extraer verificación de jti a middleware
test(payments): cubrir replay de webhook
chore(deps): actualizar express a 5.2.1
perf(chat): reducir payload del historial inicial
```

### 3.3 Ejemplos incorrectos

```text
arreglos varios
Update README.md
feat: cosas
WIP
fix: fixed bug
```

### 3.4 Reglas de escritura

| Regla | Detalle |
|---|---|
| Imperativo | “añade”, no “añadido” ni “añadiendo” |
| Minúsculas | Salvo nombres propios |
| Sin punto final | En el asunto |
| Asunto ≤ 72 caracteres | Debe leerse en `git log --oneline` |
| Un cambio lógico por commit | No mezcles dominios |
| Cuerpo en español | Explica el **por qué**, no el qué |
| Footer para issues | `Closes #123`, `Fixes #456` |

### 3.5 Breaking changes

Si el cambio rompe compatibilidad, márcalo explícitamente:

```text
feat(api)!: renombrar /api/auth/signup a /api/auth/register

BREAKING CHANGE: los clientes deben actualizar la ruta.
```

---

## 4. Estándares de código

### 4.1 Frontend: Vanilla JS, sin frameworks

El cliente es HTML, CSS y JavaScript vanilla. **No** se admiten frameworks, bundlers ni pasos de compilación en `public/`.

| Regla | Detalle |
|---|---|
| Módulos | ES Modules (`import` / `export`) |
| `var` | **Prohibido**. Usa `const` por defecto y `let` solo si hay reasignación |
| Comillas | Simples en JavaScript |
| Punto y coma | Sí |
| Indentación | 2 espacios |
| Longitud de línea | ≤ 100 caracteres |
| Fin de línea | LF |
| Encoding | UTF-8 |
| Estado global | Evítalo; encapsula en módulos o IIFEs |
| DOM | `textContent` por defecto; `innerHTML` solo con saneamiento explícito |
| APIs | `fetch`, `async` / `await`, sin callbacks anidados |

```js
// ✅ Correcto
const MAX_RETRIES = 3;
let attempts = 0;

async function loadChats() {
  const response = await fetch('/api/chats');
  if (!response.ok) throw new Error('No se pudieron cargar los chats');
  return response.json();
}

// ❌ Prohibido
var chats = [];
function loadChats(cb) {
  $.get('/api/chats', function (data) { cb(data); });
}
```

### 4.2 Backend: ESM y responsabilidades separadas

| Regla | Detalle |
|---|---|
| Módulos | ESM (`"type": "module"`) |
| Archivos de servicio | `kebab-case.js` |
| Archivos de ruta | `kebab-case.routes.js` |
| Variables y funciones | `camelCase` |
| Constantes | `UPPER_SNAKE_CASE` |
| Clases | `PascalCase` |
| Booleanos | Prefijo `is`, `has` o `can` |
| Funciones | Máximo ~40 líneas y 4 parámetros |
| Errores | `throw new Error(...)`, nunca strings |
| SQL | Tagged templates de `postgres.js`; `sql.unsafe` solo con strings constantes |
| Validación | Zod en el borde de la request |

```js
// ✅ Una responsabilidad, retorno explícito
export async function findOrderByPaypalId(orderId) {
  const [row] = await sql`
    select * from payment_orders where paypal_order_id = ${orderId}
  `;
  return row ?? null;
}
```

### 4.3 Seguridad en el código

| Prohibido | Motivo |
|---|---|
| `var` | Scope confuso y bugs silenciosos |
| `eval` / `new Function` | Ejecución arbitraria |
| `innerHTML` con datos de usuario sin escapar | XSS |
| `sql.unsafe` con interpolación | SQL injection |
| `child_process` con input de usuario | RCE |
| `rejectUnauthorized: false` en producción | MITM |
| Loggear cuerpos completos, tokens o contraseñas | Fuga de datos |
| Desactivar rate limiting “temporalmente” | Abuso |

Toda consulta a un recurso con `user_id` debe filtrar por ese `user_id` en SQL, no en JavaScript.

### 4.4 Nombres y documentación

- Identificadores en inglés; mensajes de usuario en español.
- Comentarios solo cuando explican una decisión no obvia.
- No dejes `console.log` de depuración.
- No dejes `TODO` sin un issue asociado.
- Si cambias un contrato de API, actualiza `docs/`.

---

## 5. La regla de oro: nunca subas API keys

**Nunca** hagas commit de:

- `.env`, `.env.local`, `.env.*`
- `env.local.js`
- Claves de Groq, Gemini, NVIDIA, PayPal, Brevo, Supabase o JWT
- Tokens OAuth
- Certificados, `.pem`, `.key`
- Capturas con credenciales visibles

El archivo [`.gitignore`](.gitignore) ya cubre los casos comunes, pero la responsabilidad final es tuya.

### 5.1 Verificación antes de hacer commit

```bash
git diff --cached | grep -Ei 'gsk_[a-z0-9]{20,}|AIza[0-9A-Za-z_-]{35}|nvapi-[a-z0-9_-]{20,}|sk-[a-z0-9]{20,}'
```

Si hay una coincidencia, **no hagas commit**. Elimina el secreto del archivo y rota la clave en el proveedor.

### 5.2 Si ya subiste un secreto

1. Revoca la clave en el proveedor de inmediato.
2. Genera una nueva.
3. Actualiza el entorno de producción.
4. Limpia el historial con `git filter-repo` o pide ayuda al mantenedor.
5. Documenta el incidente de forma privada.

Rotar la clave es obligatorio; borrar el commit no es suficiente.

---

## 6. Tests

### 6.1 Runner oficial

Usamos `node:test` nativo. No añadas Jest, Mocha ni Vitest.

```bash
npm test
```

### 6.2 Qué debes probar

| Capa | Obligatorio |
|---|---|
| Lógica de dinero y créditos | ✅ Siempre |
| Autorización y ownership | ✅ Siempre |
| Validación de entrada | ✅ |
| Servicios puros | ✅ |
| Endpoints | ✅ Happy path + 401 |
| Frontend | ⚠️ Recomendado |

### 6.3 Ejemplo de test

```js
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

describe('PLAN_CATALOG', () => {
  test('pro cuesta 7.50 USD y da 500 créditos', () => {
    assert.equal(PLAN_CATALOG.pro.priceUsd, 7.5);
    assert.equal(PLAN_CATALOG.pro.credits, 500);
  });

  test('todos los planes duran 30 días', () => {
    for (const plan of Object.values(PLAN_CATALOG)) {
      assert.equal(plan.days, 30);
    }
  });
});
```

El nombre del test describe comportamiento, no implementación:

```js
test('devuelve 403 si la orden pertenece a otro usuario', ...)
test('no otorga créditos dos veces con el mismo orderId', ...)
test('rechaza webhook sin rawBody', ...)
```

### 6.4 Cobertura

```bash
node --test --experimental-test-coverage
```

Objetivos:

| Área | Objetivo |
|---|---|
| `src/payments` | ≥ 70 % |
| `src/middleware` | ≥ 60 % |
| `src/services` | ≥ 50 % |
| Global | ≥ 40 % |

### 6.5 Checklist antes del PR

```bash
npm ci
npm test
npm audit --omit=dev
git diff upstream/main --stat
```

- [ ] La rama está actualizada con `main`.
- [ ] Todos los tests pasan.
- [ ] Añadí tests para el comportamiento nuevo o corregido.
- [ ] No hay `console.log` de depuración.
- [ ] No hay secretos en el diff.
- [ ] No hay `TODO` sin issue asociado.
- [ ] Actualicé la documentación si cambió un contrato.
- [ ] El diff es revisable (< 500 líneas; idealmente < 200).

---

## 7. Pull Requests

### 7.1 Título

Usa el mismo formato del commit principal:

```text
feat(payments): otorgar créditos desde el catálogo en webhook
```

### 7.2 Descripción

Completa la plantilla de PR. Como mínimo:

```markdown
## Qué
Corrige el otorgamiento de créditos cuando el pago se completa solo por webhook.

## Por qué
El handler usaba `payment.credits_granted`, que es 0 antes del capture.
El usuario pagaba y recibía 0 créditos.

## Cómo
- Resuelve créditos desde `PLAN_CATALOG[order.plan_id]`
- Actualiza con guardia `where credits_granted = 0`
- Añade test de replay

## Riesgo
Bajo. Cambio aislado a `webhooks.js`.

## Evidencia
- [x] test: webhook sin capture previo otorga 500
- [x] test: replay no duplica
- [x] `npm test` verde

Closes #123
```

### 7.3 Tamaño del PR

| Líneas cambiadas | Evaluación |
|---|---|
| < 200 | Ideal |
| 200–500 | Aceptable con justificación |
| > 500 | Divide el PR |

### 7.4 Proceso de revisión

| Aspecto | Qué se revisa |
|---|---|
| Correctitud | ¿Hace lo que dice? |
| Seguridad | ¿Filtra por `user_id`? ¿Escapa salidas? |
| Tests | ¿Cubre el caso borde? |
| Estilo | ¿Sigue las convenciones? |
| Documentación | ¿Actualiza `docs/`? |
| Rollback | ¿Se puede revertir sin tocar la base de datos? |

Un PR puede ser rechazado si:

- No tiene tests para lógica sensible.
- Mezcla varios cambios no relacionados.
- Introduce dependencias sin justificación.
- Rompe compatibilidad sin documentarlo.
- Incluye secretos, datos personales o artefactos generados.
- Ignora el Código de Conducta.

### 7.5 Cambios que requieren aprobación especial

| Cambio | Requiere |
|---|---|
| Esquema de base de datos | Dump + plan de rollback |
| Flujo de pagos | Tests + revisión del titular |
| Middleware de autenticación | Tests de regresión |
| Nueva dependencia | Justificación escrita |
| Cambio de licencia | Solo el titular |
| Variables de entorno nuevas | Actualizar `.env.example` y docs |

---

## 8. Migraciones de base de datos

### 8.1 Plantilla

```sql
-- migrations/00X_descripcion_corta.sql
-- Autor: <nombre>
-- Fecha: YYYY-MM-DD
-- Reversible: sí/no

alter table "Message"
  add column if not exists provider text;

create index if not exists idx_message_provider
  on "Message" (provider);
```

### 8.2 Reglas

1. **Idempotente:** usa `if not exists`.
2. **Nombres exactos:** comillas si la tabla es PascalCase.
3. **Sin `DROP`** sin backup verificado.
4. **Índices** con `concurrently` en tablas grandes.
5. **Backfill** en una migración separada.
6. **Registrada** automáticamente por el runner en `_migrations`.
7. **Probada** con `npm run migrate:status` y `npm run migrate`.

```bash
npm run migrate:status
npm run migrate
psql "$DATABASE_URL" -c "\d \"Message\""
```

---

## 9. Documentación

Si tu cambio afecta un contrato, actualiza el documento correspondiente:

| Cambio | Documento |
|---|---|
| Endpoint | [`docs/api-reference.md`](docs/api-reference.md) |
| Tabla o columna | [`docs/database-schema.md`](docs/database-schema.md) |
| Flujo de IA | [`docs/ai-orchestration.md`](docs/ai-orchestration.md) |
| Pago | [`docs/payment-flow.md`](docs/payment-flow.md) |
| UI | [`docs/frontend-guide.md`](docs/frontend-guide.md) |
| Deploy | [`docs/deployment.md`](docs/deployment.md) |

Reglas de escritura:

- Sin relleno: si no aporta, se borra.
- Ejemplos copiados del código, no inventados.
- Tablas para comparar; diagramas Mermaid para flujos.
- Español para documentación de producto; inglés para identificadores.

---

## 10. Revisión: preguntas que se hacen siempre

1. ¿Qué pasa si `userId` es de otro usuario?
2. ¿Qué pasa si el body viene vacío o con tipos raros?
3. ¿Qué pasa si el proveedor externo falla?
4. ¿Qué pasa si la operación se ejecuta dos veces seguidas?
5. ¿Se registra algo sensible en los logs?
6. ¿Se puede revertir el deploy sin tocar la base de datos?
7. ¿El test falla si rompo la lógica a propósito?

Si alguna respuesta es “no sé”, el PR no está listo.

---

## 11. Release

| Paso | Acción |
|---|---|
| 1 | `main` en verde |
| 2 | Actualizar versión en `package.json` |
| 3 | Actualizar `README.md` si aplica |
| 4 | Crear tag `vX.Y.Z` |
| 5 | Desplegar |
| 6 | Verificar healthcheck |
| 7 | Comunicar cambios |

| Cambio | Versión |
|---|---|
| Bugfix | Patch |
| Feature compatible | Minor |
| Breaking change | Major |

---

## 12. Código de Conducta

Al participar aceptas el [Código de Conducta](CODE_OF_CONDUCT.md). En resumen:

| Se espera | No se tolera |
|---|---|
| Crítica técnica directa | Ataques personales |
| Preguntas aunque parezcan básicas | Condescendencia |
| Reconocer errores | Culpar a otros |
| Revisiones específicas | “Esto está mal” sin explicar |
| Respeto al tiempo ajeno | PRs de 3 000 líneas sin contexto |

El desacuerdo técnico se resuelve con evidencia, no con jerarquía.

---

## 13. Recursos

| Recurso | Dónde |
|---|---|
| Arquitectura | [`docs/architecture.md`](docs/architecture.md) |
| Instalación | [`docs/installation.md`](docs/installation.md) |
| API | [`docs/api-reference.md`](docs/api-reference.md) |
| Seguridad | [`SECURITY.md`](SECURITY.md) |
| Troubleshooting | [`docs/troubleshooting.md`](docs/troubleshooting.md) |
| Licencia | [`docs/LICENSE.md`](docs/LICENSE.md) |
| Soporte | [`.github/SUPPORT.md`](.github/SUPPORT.md) |

---

Gracias por contribuir. El estándar es alto a propósito: el código que llega a producción lo usan personas reales.
