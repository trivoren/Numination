# Troubleshooting

> **Uso:** diagnóstico operativo. Busca el síntoma, aplica la causa, verifica.
> **Si nada aplica:** revisa `requestId` en la respuesta y búscalo en los logs.

---

## 1. Árbol de decisión

```mermaid
flowchart TD
    A[Problema] --> B{¿Afecta a todos?}
    B -- Sí --> C{¿Healthcheck OK?}
    C -- No --> D[DB / proceso / env]
    C -- Sí --> E[Middleware / config]
    B -- No --> F{¿Un usuario?}
    F -- Sí --> G[Permisos / plan / datos]
    F -- No --> H{¿Una función?}
    H -- Chat --> I[Proveedores IA]
    H -- Pagos --> J[PayPal / webhook]
    H -- RAG --> K[pgvector / indexación]
```

---

## 2. Arranque

### `JWT_SECRET is required`

| Causa | Solución |
|---|---|
| Falta la variable | Añadir a `.env.local` |
| Archivo no cargado | Verificar que el proceso corre desde la raíz |
| Nombre mal escrito | Debe ser exactamente `JWT_SECRET` |

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

### `ECONNREFUSED 127.0.0.1:5432`

```bash
docker ps | grep postgres
psql "$DATABASE_URL" -c "select 1"
```

Si usas Supabase, revisa que la URL sea el **pooler** (`...pooler.supabase.com:6543`) y no la conexión directa.

### `EADDRINUSE :8080`

```bash
netstat -ano | findstr :8080     # Windows
lsof -i :8080                     # macOS/Linux
```

```bash
PORT=8081 npm run dev
```

### `Cannot find module`

| Causa | Solución |
|---|---|
| `node_modules` incompleto | `npm ci` |
| Ruta relativa mal | Importar con `./` o `../`, no con `/src/...` |
| ESM sin extensión | En ESM se requiere `.js` explícito |

### El proceso arranca y muere sin error

```bash
node --trace-uncaught src/index.js
node --enable-source-maps src/index.js
```

Revisa si hay una promesa rechazada sin `catch` en un `setInterval` o en un handler de arranque.

---

## 3. Autenticación

### 401 en todas las rutas autenticadas

| Paso | Verificación |
|---|---|
| 1 | ¿La cookie `token` llega? DevTools → Application → Cookies |
| 2 | ¿`HttpOnly` + `Secure` impiden el envío en `http://`? En local debe ser `Secure=false` |
| 3 | ¿`SameSite` bloquea el request cross-origin? |
| 4 | ¿`JWT_SECRET` cambió y el token es viejo? |
| 5 | ¿El `jti` está en `revoked_sessions`? |

```js
// decodificar sin verificar (sólo para depurar)
const p = JSON.parse(atob(localStorage.getItem('debug_token').split('.')[1]));
console.log(p.exp * 1000 < Date.now() ? 'expirado' : 'vigente', p.jti);
```

### 401 justo después de un deploy

Cambiaste `JWT_SECRET`. Todos los tokens viejos son inválidos. Es el comportamiento esperado; los usuarios deben volver a iniciar sesión.

### `SESSION_REVOKED` intermitente

El usuario cerró sesión en otro dispositivo, o hay un job que revoca por error. Verifica:

```sql
select * from revoked_sessions order by revoked_at desc limit 10;
```

### OAuth: `redirect_uri_mismatch`

| Causa | Solución |
|---|---|
| URL distinta | Debe coincidir exactamente con la registrada |
| `http` vs `https` | Producción exige `https` |
| Barra final | Quitar o añadir según el proveedor |
| `APP_URL` desactualizada | Corregir y redeploy |

### OAuth: `INVALID_STATE`

| Causa | Solución |
|---|---|
| Cookie de `state` no guardada | Verificar `SameSite` y dominio |
| Segunda pestaña | El `state` es de un solo uso |
| Tiempo > 10 min | Reiniciar el flujo |

### El login "funciona" pero `/api/me` devuelve 401

La cookie se emitió para un dominio distinto (`www` vs apex). Fija un canonical y redirige.

---

## 4. Chat e IA

### `503 ALL_PROVIDERS_FAILED`

```mermaid
flowchart TD
    A[503] --> B{¿Hay keys configuradas?}
    B -- No --> C[Añadir GROQ_API_KEY o GEMINI_API_KEY]
    B -- Sí --> D{¿429 en logs?}
    D -- Sí --> E[Cuota agotada<br/>rotar keys o esperar]
    D -- No --> F{¿Timeout?}
    F -- Sí --> G[Proveedor lento<br/>bajar timeout o cambiar orden]
    F -- No --> H{¿401/403?}
    H -- Sí --> I[Key inválida o revocada]
    H -- No --> J[Revisar nombre de modelo]
```

**Diagnóstico:**

```bash
grep -i "provider failed" logs.txt | tail -20
grep -i "ALL_PROVIDERS_FAILED" logs.txt | tail -5
```

**Verificar la cadena efectiva** al arrancar:

```text
[info] ai providers: groq, gemini, kimi
```

Si solo aparece uno, los demás no tienen key.

### El stream no llega / llega de golpe

| Capa | Acción |
|---|---|
| Nginx | `proxy_buffering off` |
| Cloudflare | Desactivar "Rocket Loader" para `/api/*` |
| Vercel | Verificar que no se excede el timeout |
| Cliente | Confirmar `TextDecoder({ stream: true })` |
| Servidor | Hacer `res.flushHeaders()` antes del primer token |

### El stream se corta a los 30 s

Casi siempre es un proxy con timeout de 30 s. En Vercel, el límite depende del plan. Mitigaciones:

1. Heartbeat cada 15 s (ya implementado).
2. Reducir la longitud de la respuesta.
3. Mover a VPS para streams largos.

### Respuestas duplicadas

| Causa | Solución |
|---|---|
| Doble listener en el botón | Usar `{ once: true }` o remover |
| Reintento del cliente | Cancelar el `AbortController` anterior |
| Dos pestañas | Bloquear envío si `streaming === true` |
| SSE reemitido por proxy | `Cache-Control: no-transform` |

### Caracteres corruptos

Falta `stream: true` en el decoder:

```js
const decoder = new TextDecoder();
decoder.decode(value, { stream: true });  // ✅
```

Sin eso, un carácter UTF-8 partido entre chunks se decodifica mal.

### Los créditos no bajan

1. ¿La respuesta terminó en `done`? Si hubo error, no se cobra.
2. ¿El handler llama a `debitCredits`?
3. ¿La transacción hizo rollback?

```sql
select credits from profiles where id = $1;
select * from credit_ledger where user_id = $1 order by created_at desc limit 5;
```

### Los créditos bajan dos veces

| Causa | Solución |
|---|---|
| Doble submit | Bloquear botón |
| Reintento del cliente | Idempotencia por `messageId` |
| Webhook + capture | `on conflict` en ledger |

---

## 5. Pagos

### `Firma inválida.` (401 en webhook)

| Causa | Verificación |
|---|---|
| `rawBody` ausente | Log de longitud del body |
| Parser JSON antes del `verify` | Revisar orden del middleware |
| `PAYPAL_WEBHOOK_ID` incorrecto | Comparar con el dashboard |
| `cert_url` no allowlisted | Revisar hostname |
| Reloj desincronizado | NTP activo |
| Evento reenviado con headers viejos | PayPal reintenta con nuevos |

```js
// diagnóstico temporal
console.log('rawBody bytes:', req.rawBody?.length);
console.log('headers:', {
  id: req.get('paypal-transmission-id'),
  cert: req.get('paypal-cert-url'),
  algo: req.get('paypal-auth-algo')
});
```

### El webhook responde 200 pero no acredita

1. ¿El evento es `PAYMENT.CAPTURE.COMPLETED`?
2. ¿La orden existe localmente? (`select * from payment_orders where paypal_order_id = ...`)
3. ¿`credits_granted` ya era > 0?
4. ¿El handler usa `payment.credits_granted` en lugar del plan? → **defecto conocido**, ver [`payment-flow.md`](./payment-flow.md#6-defecto-conocido-créditos-en-0).

### Usuario pagó y no tiene créditos

```sql
select id, user_id, plan_id, status, credits_granted, created_at
from payment_orders
where user_id = $1
order by created_at desc
limit 5;
```

Si `status = 'completed'` y `credits_granted = 0`:

```sql
begin;
update payment_orders
set credits_granted = 500
where id = $orderId and credits_granted = 0;
update profiles set credits = credits + 500 where id = $userId;
insert into credit_ledger (user_id, delta, reason, order_id)
values ($userId, 500, 'manual_repair', $orderId);
commit;
```

### `PAYPAL_CAPTURE_FAILED`

| Código PayPal | Significado |
|---|---|
| `ORDER_ALREADY_CAPTURED` | Ya se capturó; responder `alreadyCompleted` |
| `ORDER_NOT_APPROVED` | El usuario no aprobó |
| `INSTRUMENT_DECLINED` | Tarjeta rechazada |
| `PAYER_ACTION_REQUIRED` | Requiere acción adicional |

### Sandbox funciona, live no

| Causa | Solución |
|---|---|
| `PAYPAL_MODE=sandbox` en prod | Cambiar a `live` |
| Credenciales sandbox en prod | Usar las live |
| Webhook registrado en sandbox | Registrar en live |
| Cuenta live sin verificar | Completar verificación de negocio |

---

## 6. RAG

### `relation "rag_chunks" does not exist`

Falta la tabla. Aplicar la migración correspondiente o crearla con el DDL de [`database-schema.md`](./database-schema.md).

### `type "vector" does not exist`

```sql
create extension if not exists vector;
```

Si no tienes permisos, pide al administrador de la DB.

### Documento atascado en `pending`

1. ¿El proceso de indexación terminó?
2. ¿Hubo un error de embeddings?
3. ¿El proceso murió por timeout (Vercel)?

```sql
select id, filename, status, chunk_count, created_at
from rag_documents
where status = 'pending' and created_at < now() - interval '10 minutes';
```

Reintentar:

```bash
curl -b cookies.txt -X POST /api/rag/documents/$ID/reindex
```

### RAG lento

**Causa:** falta índice vectorial. Sin él, cada búsqueda escanea todos los chunks.

```sql
create index concurrently idx_rag_chunks_embedding
  on rag_chunks using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64);
```

Verificar que se usa:

```sql
explain analyze
select id from rag_chunks
where user_id = '...'
order by embedding <=> '[...]'::vector
limit 6;
```

Debe decir `Index Scan using idx_rag_chunks_embedding`, no `Seq Scan`.

### Resultados irrelevantes

| Causa | Solución |
|---|---|
| Chunks muy grandes | Reducir `chunkSize` |
| Modelo de embeddings distinto | Reindexar `where embedding_model != 'actual'` |
| Umbral muy bajo | Subir el mínimo de similitud |
| Documento escaneado sin OCR | El PDF es imagen; no hay texto |

```sql
select embedding_model, count(*) from rag_chunks group by 1;
```

### `embedding is null`

El fallback determinista se usó o el embedding falló. Reindexar:

```sql
update rag_chunks set embedding = null where embedding_model = 'fallback-hash';
```

---

## 7. Base de datos

### `relation "profiles" does not exist`

La DB está vacía. Ejecutar el DDL base de [`database-schema.md`](./database-schema.md).

### `relation "messages" does not exist`

La migración `001` apunta a minúsculas pero el runtime usa `"Message"`. Opciones:

```sql
-- Opción A: crear vista
create view messages as select * from "Message";

-- Opción B: corregir la migración y volver a aplicarla
-- (recomendado)
```

### `too many connections`

Supabase limita las conexiones directas. Usa el pooler:

```
postgresql://postgres.[ref]:[pass]@aws-0-[region].pooler.supabase.com:6543/postgres
```

Y reduce el pool de `postgres.js`:

```js
postgres(url, { max: 5, idle_timeout: 20 });
```

### Query lenta

```sql
select pid, now() - pg_stat_activity.query_start as duration, query, state
from pg_stat_activity
where state <> 'idle'
order by duration desc
limit 10;
```

```sql
select * from pg_stat_statements order by mean_exec_time desc limit 10;
```

### Bloqueos

```sql
select blocked.pid as blocked_pid,
       blocking.pid as blocking_pid,
       blocked.query as blocked_query
from pg_stat_activity blocked
join pg_stat_activity blocking
  on blocking.pid = any(pg_blocking_pids(blocked.pid))
where cardinality(pg_blocking_pids(blocked.pid)) > 0;
```

```sql
select pg_terminate_backend($pid);
```

---

## 8. Frontend

### Página en blanco

1. Consola: ¿error de sintaxis?
2. Network: ¿404 en un script?
3. ¿Orden de carga incorrecto (`async` en dependencias)?
4. ¿CSP bloqueando un script?

### `Escritura is not defined`

El script no se cargó o se cargó después de `main.js`. Verifica el orden y `defer`.

### El tema parpadea

El script de tema debe ejecutarse inline en `<head>`, antes del primer paint.

### SSE no actualiza la UI

| Causa | Solución |
|---|---|
| `innerHTML` sin re-render | Llamar a `Escritura.render` |
| Throttle mal configurado | Verificar el temporizador |
| Excepción silenciosa | Envolver el handler en `try/catch` |

### XSS en el chat

Si un mensaje con `<img src=x onerror=alert(1)>` ejecuta código, el escape está roto. Revisar el orden en `highlight()` y cualquier `innerHTML` nuevo.

---

## 9. Rendimiento

| Síntoma | Diagnóstico | Acción |
|---|---|---|
| Primera carga lenta | Cold start | Reducir dependencias |
| Chat lento en el primer token | Proveedor | Cambiar orden de la cadena |
| Chat lento en general | Tokens | Limitar contexto |
| UI con lag al streamear | Render por token | Throttle |
| DB lenta | Seq scan | Índices |
| Memoria alta | PDFs grandes | Límite de tamaño |

### Medir el primer token

```js
const t0 = performance.now();
// ... primer evento 'token'
console.log('TTFT', performance.now() - t0, 'ms');
```

| TTFT | Evaluación |
|---|---|
| < 800 ms | Excelente |
| 800–2000 ms | Aceptable |
| > 2000 ms | Revisar proveedor |

---

## 10. Logs y diagnóstico

### Correlación por request

```bash
grep "requestId=abc-123" logs.txt
```

### Niveles

| Nivel | Uso |
|---|---|
| `error` | Fallo que requiere acción |
| `warn` | Degradación (fallback de proveedor) |
| `info` | Evento de negocio |
| `debug` | Sólo en desarrollo |

### Qué buscar tras un incidente

```bash
grep -c "provider failed" logs.txt
grep "ALL_PROVIDERS_FAILED" logs.txt | head
grep "Firma inválida" logs.txt | wc -l
grep "idor_attempt" logs.txt | wc -l
```

---

## 11. Scripts de emergencia

### Estado general

```sql
select
  (select count(*) from profiles) as users,
  (select count(*) from "Chat") as chats,
  (select count(*) from "Message") as messages,
  (select count(*) from payment_orders where status='completed') as paid_orders,
  (select count(*) from payment_orders where status='completed' and credits_granted=0) as broken_orders;
```

### Usuarios suspendidos

```sql
select user_id, strikes, risk_score, suspended_until
from user_moderation
where suspended_until > now();
```

### Limpiar idempotencia vieja

```sql
delete from payment_idempotency where created_at < now() - interval '1 hour';
```

### Limpiar sesiones revocadas expiradas

```sql
delete from revoked_sessions where expires_at < now();
```

### Reindexar un documento

```sql
update rag_documents set status = 'pending', chunk_count = 0 where id = $1;
delete from rag_chunks where document_id = $1;
```

---

## 12. Cuándo escalar

| Situación | Acción |
|---|---|
| Pérdida de datos | Detener escrituras, restaurar backup |
| Fuga de credenciales | Rotar todo, revisar accesos |
| Cobros duplicados | Pausar captura, conciliar, reembolsar |
| Caída > 15 min | Comunicar estado, revisar infra |
| Bug de seguridad | Parche inmediato, post-mortem |

---

## 13. Matriz rápida

| Código | Probable causa | Primer paso |
|---|---|---|
| 400 | Payload inválido | Revisar Zod |
| 401 | Sin sesión / firma | Cookies / `rawBody` |
| 402 | Plan insuficiente | Verificar `plan` |
| 403 | Ajeno / suspendido | `user_id` / moderación |
| 404 | No existe | ID correcto |
| 409 | Conflicto | Duplicado / stale |
| 429 | Rate limit | Esperar / subir límite |
| 500 | Excepción | Buscar `requestId` |
| 502 | PayPal | Revisar credenciales |
| 503 | IA caída | Cadena de proveedores |

*Ver también: [`security.md`](./security.md) y [`deployment.md`](./deployment.md).*
