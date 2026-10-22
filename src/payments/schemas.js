/* ═══════════════════════════════════════════════════════════════════════
   NUMINATION · payments/schemas.js · v1.0
   ───────────────────────────────────────────────────────────────────────
   Contratos de entrada y catálogo de planes del módulo de pagos.

   OBJETIVO:
     · Fuente ÚNICA de verdad de los precios. El cliente NUNCA envía un
       precio: manda `planId` y el servidor decide cuánto vale. Esto elimina
       la clase completa de ataques "precio manipulado" y "monto negativo".
     · Validación estricta (fail-fast) con Zod: objeto estricto (unknown
       keys → 400), enum cerrado de planes, formatos strictos de IDs.
     · Rechazo explícito de patrones de inyección SQL: aunque el enum ya
       lo impide, se documenta y se blinda con un refine para que un
       cambio futuro del catálogo no abra la puerta.

   RESPUESTAS DE ERROR:
     · Todas las violaciones se traducen a `ValidationError` (HTTP 400)
       del middleware centralizado `src/middleware/errors.js`, de modo que
       el cliente recibe siempre el mismo formato JSON:
         { ok:false, error:'...', code:'valid_invalid_field', ... }
   ═══════════════════════════════════════════════════════════════════════ */

import { z } from 'zod';
import { ValidationError, CODES } from '../middleware/errors.js';

/* ═══════════════════════════════════════════════════════════════════════
   1 · CONSTANTES DE NEGOCIO
   ═══════════════════════════════════════════════════════════════════════ */

/** Plan IDs permitidos. Cerrado y explícito: nunca se acepta un string libre. */
export const PLAN_IDS = Object.freeze(['pro', 'ultimate']);

/** Duración de la suscripción (días). */
export const SUBSCRIPTION_DAYS = 30;

/**
 * Catálogo de planes. El precio se cobra en USD (PayPal no opera en COP);
 * el monto en COP es solo una referencia de display para el usuario.
 *
 * `credits` = créditos de IA que se acreditan al activar el plan.
 */
export const PLAN_CATALOG = Object.freeze({
  pro: Object.freeze({
    id: 'pro',
    name: 'Pro',
    amountCop: 30000,
    amountUsd: 7.5,
    currency: 'USD',
    credits: 500,
    featured: false,
    badge: null,
    features: Object.freeze([
      '500 créditos de IA cada mes',
      'Acceso a todos los modelos',
      'Historial de chats sin límites',
      'Exportación de proyectos',
    ]),
  }),
  ultimate: Object.freeze({
    id: 'ultimate',
    name: 'Ultimate',
    amountCop: 45000,
    amountUsd: 11,
    currency: 'USD',
    credits: 1200,
    featured: true,
    badge: 'Popular',
    features: Object.freeze([
      '1.200 créditos de IA cada mes',
      'Todos los modelos + modo avanzado',
      'Coder en la nube sin cola',
      'Soporte prioritario 24/7',
    ]),
  }),
});

/** Lista pública de planes (lo que ve el frontend). */
export function listPlans() {
  return Object.values(PLAN_CATALOG).map((plan) => ({
    id: plan.id,
    name: plan.name,
    amountCop: plan.amountCop,
    amountUsd: plan.amountUsd,
    currency: plan.currency,
    credits: plan.credits,
    featured: plan.featured,
    badge: plan.badge,
    features: plan.features.slice(),
  }));
}

/** Devuelve el plan del catálogo o `null` si no existe. */
export function getPlan(planId) {
  if (typeof planId !== 'string') return null;
  return Object.prototype.hasOwnProperty.call(PLAN_CATALOG, planId)
    ? PLAN_CATALOG[planId]
    : null;
}

/* ═══════════════════════════════════════════════════════════════════════
   2 · SCHEMAS ZOD
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Patrones de inyección SQL / traversal. Se aplican sobre el texto plano
 * para que un payload malicioso quede registrado en el log de seguridad
 * (el error 400 incluye el motivo) y no dependa solo del enum.
 */
const SQL_INJECTION_RE = /(\b(union\s+select|insert\s+into|update\s+\w+\s+set|delete\s+from|drop\s+(table|database|schema)|alter\s+table|truncate\s+table|exec\s*\(|execute\s+immediate|information_schema|pg_catalog|pg_sleep|sleep\s*\(|benchmark\s*\(|load_file|outfile|dumpfile)\b|--|\/\*|\*\/|;|\bor\b\s+\d+\s*=\s*\d+|\band\b\s+\d+\s*=\s*\d+)/i;

const TRAVERSAL_RE = /(\.\.[/\\]|\.\.\\|%2e%2e|%252e|file:\/\/|php:\/\/|data:text\/html)/i;

/**
 * `planId`: SOLO 'pro' o 'ultimate'.
 *  · `z.enum` ya rechaza cualquier otro string con 400.
 *  · El refine documenta y blinda contra payloads con forma de inyección.
 */
export const planIdSchema = z
  .string({ error: 'planId debe ser texto.' })
  .trim()
  .min(1, { error: 'planId no puede estar vacío.' })
  .max(32, { error: 'planId es demasiado largo.' })
  .refine(
    (value) => !SQL_INJECTION_RE.test(value),
    { error: 'planId contiene caracteres no permitidos.' }
  )
  .refine(
    (value) => !TRAVERSAL_RE.test(value),
    { error: 'planId contiene caracteres no permitidos.' }
  )
  .refine(
    (value) => PLAN_IDS.includes(value),
    { error: `planId debe ser uno de: ${PLAN_IDS.join(', ')}.` }
  );

/** UUID v4 en formato canónico (el orderId que genera el backend). */
export const uuidSchema = z
  .string({ error: 'orderId debe ser texto.' })
  .trim()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    { error: 'orderId no tiene un formato UUID válido.' }
  );

/**
 * Body de `POST /api/payments/create-order`.
 * Estricto: cualquier key extra (p. ej. `amount`, `userId`, `credits`)
 * provoca 400. Esto bloquea mass-assignment: el cliente no puede
 * pedir que se le acredite otra cantidad de créditos.
 */
export const createOrderSchema = z.strictObject({
  planId: planIdSchema,
});

/**
 * Body de `POST /api/payments/capture-order`.
 * Estricto por la misma razón: el backend resuelve el precio, el plan y el
 * usuario desde la orden persistida, nunca desde el body.
 */
export const captureOrderSchema = z.strictObject({
  orderId: uuidSchema,
});

/**
 * Query opcional de `GET /api/payments/history`.
 */
export const historyQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(50).default(10).optional(),
});

/* ═══════════════════════════════════════════════════════════════════════
   3 · TRADUCCIÓN DE ERRORES ZOD → AppError (400)
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Convierte un ZodError en un `ValidationError` (HTTP 400) con el formato
 * estándar del proyecto. Nunca filtra el stack ni el valor recibido.
 */
function toValidationError(error, context = {}) {
  const issues = (error && error.issues) || [];
  const first = issues[0] || {};
  const field = Array.isArray(first.path) && first.path.length ? first.path.join('.') : null;

  const details = issues.slice(0, 10).map((issue) => ({
    field: Array.isArray(issue.path) && issue.path.length ? issue.path.join('.') : null,
    message: issue.message || 'Valor inválido.',
    code: issue.code || 'invalid',
  }));

  return new ValidationError(
    first.message || 'Datos inválidos.',
    field,
    CODES.VALID_INVALID_FIELD,
    { ...context, issues: details }
  );
}

/**
 * Valida y normaliza un payload. Lanza `ValidationError` (400) si falla.
 *
 * @param {import('zod').ZodTypeAny} schema
 * @param {unknown} data
 * @param {object} [context] Contexto extra para el log (no se filtra al cliente).
 * @returns {object} Payload validado y normalizado.
 */
export function parseOrThrow(schema, data, context = {}) {
  try {
    const result = schema.safeParse(data);
    if (result.success) return result.data;

    const err = toValidationError(result.error, context);
    err.isValidationError = true;
    throw err;
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    // Zod lanzó algo inesperado (no debería pasar): 400 genérico, sin detalle.
    throw new ValidationError(
      'Datos inválidos.',
      null,
      CODES.VALID_INVALID_FIELD,
      { ...context, reason: String(err && err.message ? err.message : err).slice(0, 200) }
    );
  }
}

/**
 * Variante que NO lanza: devuelve `{ ok, data | errors }`.
 * Útil para validaciones internas que no deben abortar el flujo.
 */
export function safeParse(schema, data) {
  const result = schema.safeParse(data);
  if (result.success) return { ok: true, data: result.data };

  return {
    ok: false,
    errors: (result.error.issues || []).slice(0, 10).map((issue) => ({
      field: Array.isArray(issue.path) && issue.path.length ? issue.path.join('.') : null,
      message: issue.message || 'Valor inválido.',
      code: issue.code || 'invalid',
    })),
  };
}

/**
 * Valida el planId y devuelve el objeto del catálogo.
 * Lanza ValidationError (400) si el plan no existe.
 */
export function resolvePlan(planId) {
  const parsed = parseOrThrow(planIdSchema, planId, { field: 'planId' });
  const plan = getPlan(parsed);
  if (!plan) {
    throw new ValidationError(
      `El plan "${parsed}" no existe.`,
      'planId',
      CODES.VALID_INVALID_FIELD,
      { allowed: PLAN_IDS }
    );
  }
  return plan;
}

/* ═══════════════════════════════════════════════════════════════════════
   4 · SELF-TEST (ejecutable con `node --test` o manual)
   ═══════════════════════════════════════════════════════════════════════ */

export function selfTest() {
  const results = [];
  const rec = (name, ok, detail) => results.push({ name, ok, detail });

  rec('planId acepta pro', safeParse(planIdSchema, 'pro').ok, true);
  rec('planId acepta ultimate', safeParse(planIdSchema, 'ultimate').ok, true);
  rec('planId rechaza free', !safeParse(planIdSchema, 'free').ok, true);
  rec('planId rechaza vacío', !safeParse(planIdSchema, '').ok, true);
  rec('planId rechaza SQL', !safeParse(planIdSchema, "pro'; DROP TABLE profiles;--").ok, true);
  rec('planId rechaza UNION', !safeParse(planIdSchema, 'pro UNION SELECT 1').ok, true);
  rec('planId rechaza traversal', !safeParse(planIdSchema, '../../etc/passwd').ok, true);
  rec('planId rechaza número', !safeParse(planIdSchema, 42).ok, true);
  rec('planId rechaza array', !safeParse(planIdSchema, ['pro']).ok, true);

  rec('createOrder acepta válido', safeParse(createOrderSchema, { planId: 'pro' }).ok, true);
  rec('createOrder rechaza key extra', !safeParse(createOrderSchema, { planId: 'pro', amount: 1 }).ok, true);
  rec('createOrder rechaza amount', !safeParse(createOrderSchema, { planId: 'pro', amountUsd: 0.01 }).ok, true);
  rec('createOrder rechaza userId', !safeParse(createOrderSchema, { planId: 'pro', userId: 'x' }).ok, true);

  rec('captureOrder acepta uuid', safeParse(captureOrderSchema, { orderId: '123e4567-e89b-42d3-a456-426614174000' }).ok, true);
  rec('captureOrder rechaza no-uuid', !safeParse(captureOrderSchema, { orderId: 'abc' }).ok, true);
  rec('captureOrder rechaza SQL', !safeParse(captureOrderSchema, { orderId: "1' OR '1'='1" }).ok, true);

  rec('getPlan pro', getPlan('pro').amountUsd === 7.5, getPlan('pro'));
  rec('getPlan ultimate', getPlan('ultimate').amountUsd === 11, getPlan('ultimate'));
  rec('getPlan inexistente', getPlan('__proto__') === null, true);
  rec('listPlans devuelve 2', listPlans().length === 2, listPlans().length);

  const passed = results.filter((r) => r.ok).length;
  return { passed, total: results.length, ok: passed === results.length, results };
}
