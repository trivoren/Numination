/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · lib/validators.js · v1.0
   ─────────────────────────────────────────────────────────────────────────
   Validación de payloads con schemas encadenables. Cero dependencias.

   FILOSOFÍA:
     · Un solo lugar para validar cada endpoint
     · Mensajes de error claros en español
     · Coacción de tipos (string "42" → number 42)
     · Composable: schemas se anidan sin límite
     · Middleware Express listo para usar

   API PÚBLICA:
     v.string()            → StringSchema
     v.number()            → NumberSchema
     v.boolean()           → BooleanSchema
     v.date()              → DateSchema
     v.array(schema)       → ArraySchema
     v.object({...})       → ObjectSchema
     v.enum([...])         → EnumSchema
     v.any()               → AnySchema
     v.literal(x)          → LiteralSchema
     v.union([...])        → UnionSchema

     v.email()             → StringSchema con regex de email
     v.url()               → StringSchema con regex de URL
     v.uuid()              → StringSchema con regex UUID v4
     v.ip()                → StringSchema con validación IP
     v.phone()             → StringSchema con validación teléfono

     validate(schema, data)      → { ok, data, errors }
     validateOrThrow(schema, data) → data (tira error si falla)
     middleware(schema, opts)    → middleware Express

     v.test()                    → self-test

   USO:
     import { v, validate, middleware } from './lib/validators.js';

     const ChatSchema = v.object({
       message: v.string().min(1).max(4000),
       role: v.enum(['student', 'teacher', 'reasoning']).default('student'),
       history: v.array(v.object({
         role: v.enum(['user', 'assistant']),
         content: v.string().max(10000),
       })).max(50).optional(),
       webSearch: v.boolean().default(false),
       chatId: v.string().uuid().optional(),
     });

     app.post('/api/chat', middleware(ChatSchema), (req, res) => {
       // req.validated tiene el payload validado y normalizado
       const { message, role } = req.validated;
     });
   ═══════════════════════════════════════════════════════════════════════════ */

import { createLogger } from './logger.js';

const log = createLogger('validators');

/* ═══════════════════════════════════════════════════════════════════════════
   01 · CONFIGURACIÓN
   ═══════════════════════════════════════════════════════════════════════════ */

const CFG = {
  // Idioma de los mensajes
  language: 'es',

  // Máximo de errores a devolver (evita payloads gigantes)
  maxErrors: 20,

  // Path de errores: 'first' (solo el primero), 'all' (todos)
  errorMode: 'all',

  // Coaccionar tipos automáticamente
  coerce: true,

  // Stripear campos desconocidos en objetos
  stripUnknown: true,

  // Modo debug: loggea cada validación
  debug: process.env.VALIDATOR_DEBUG === 'true',
};

/* ═══════════════════════════════════════════════════════════════════════════
   02 · TIPOS DE ERROR
   ═══════════════════════════════════════════════════════════════════════════ */

class ValidationError extends Error {
  constructor(errors, data) {
    const msg = Array.isArray(errors) && errors.length > 0
      ? errors[0].message
      : 'Datos inválidos';
    super(msg);
    this.name = 'ValidationError';
    this.errors = errors;
    this.data = data;
    this.isValidationError = true;
  }

  toJSON() {
    return {
      ok: false,
      error: this.message,
      code: 'VALIDATION_ERROR',
      errors: this.errors,
    };
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   03 · MENSAJES
   ═══════════════════════════════════════════════════════════════════════════ */

const MSG = {
  required: 'Este campo es obligatorio',
  invalid_type: (expected, got) => `Se esperaba ${expected}, se recibió ${got}`,
  invalid_type_simple: (expected) => `Se esperaba ${expected}`,
  string_min: (n) => `Debe tener al menos ${n} caracteres`,
  string_max: (n) => `Debe tener máximo ${n} caracteres`,
  string_length: (n) => `Debe tener exactamente ${n} caracteres`,
  string_pattern: 'Formato inválido',
  string_email: 'Email inválido',
  string_url: 'URL inválida',
  string_uuid: 'UUID inválido',
  string_ip: 'Dirección IP inválida',
  string_phone: 'Teléfono inválido',
  number_min: (n) => `Debe ser mayor o igual a ${n}`,
  number_max: (n) => `Debe ser menor o igual a ${n}`,
  number_int: 'Debe ser un número entero',
  number_positive: 'Debe ser un número positivo',
  number_negative: 'Debe ser un número negativo',
  number_finite: 'Debe ser un número finito',
  array_min: (n) => `Debe tener al menos ${n} elemento${n === 1 ? '' : 's'}`,
  array_max: (n) => `Debe tener máximo ${n} elemento${n === 1 ? '' : 's'}`,
  array_length: (n) => `Debe tener exactamente ${n} elemento${n === 1 ? '' : 's'}`,
  array_unique: 'No puede tener elementos duplicados',
  object_required: (key) => `El campo "${key}" es obligatorio`,
  enum_invalid: (values) => `Debe ser uno de: ${values.join(', ')}`,
  custom: 'Valor inválido',
  any_fail: 'Valor inválido',
};

/* ═══════════════════════════════════════════════════════════════════════════
   04 · UTILIDADES
   ═══════════════════════════════════════════════════════════════════════════ */

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (value instanceof Date) return 'date';
  return typeof value;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== 'object') return false;

  if (Array.isArray(a) !== Array.isArray(b)) return false;

  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }

  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every(k => deepEqual(a[k], b[k]));
}

function uniqueArray(arr) {
  const seen = [];
  for (const item of arr) {
    if (!seen.some(s => deepEqual(s, item))) seen.push(item);
  }
  return seen;
}

function formatPath(path) {
  if (!path) return 'root';
  return path.join('.');
}

/* ═══════════════════════════════════════════════════════════════════════════
   05 · BASE SCHEMA
   ═══════════════════════════════════════════════════════════════════════════ */

class BaseSchema {
  constructor() {
    this._optional = false;
    this._nullable = false;
    this._default = undefined;
    this._hasDefault = false;
    this._transforms = [];
    this._refinements = [];
    this._customMessage = null;
  }

  /** El campo puede ser undefined. */
  optional() {
    this._optional = true;
    return this;
  }

  /** El campo puede ser null. */
  nullable() {
    this._nullable = true;
    return this;
  }

  /** Valor por defecto si el campo es undefined. */
  default(value) {
    this._default = value;
    this._hasDefault = true;
    return this;
  }

  /** Transforma el valor después de validar. */
  transform(fn) {
    this._transforms.push(fn);
    return this;
  }

  /** Agrega una validación custom. */
  refine(fn, message) {
    this._refinements.push({ fn, message: message || MSG.custom });
    return this;
  }

  /** Mensaje custom si falla la validación. */
  message(msg) {
    this._customMessage = msg;
    return this;
  }

  /** Aplica validaciones comunes de pre-procesamiento. */
  _preprocess(value, path) {
    const errors = [];

    // Undefined
    if (value === undefined) {
      if (this._hasDefault) return { value: this._default, errors: [], done: true };
      if (this._optional) return { value: undefined, errors: [], done: true };
      // nullable también acepta clave ausente (conveniencia: evita tener que
      // encadenar .optional().nullable() en todos los campos opcionales).
      // Se normaliza a null para que el valor sea consistente.
      if (this._nullable) return { value: null, errors: [], done: true };
      return { value: undefined, errors: [{ path, message: MSG.required, code: 'required' }] };
    }

    // Null
    if (value === null) {
      if (this._nullable) return { value: null, errors: [], done: true };
      if (this._optional) return { value: null, errors: [], done: true };
      return { value: null, errors: [{ path, message: MSG.required, code: 'required' }] };
    }

    return { value, errors: [], done: false };
  }

  /** Aplica refinements y transforms comunes. */
  _postprocess(value, path) {
    const errors = [];

    for (const ref of this._refinements) {
      try {
        const ok = ref.fn(value);
        if (!ok) {
          errors.push({ path, message: ref.message, code: 'refine' });
        }
      } catch (e) {
        errors.push({ path, message: ref.message || e.message, code: 'refine' });
      }
    }

    for (const fn of this._transforms) {
      try {
        value = fn(value);
      } catch (e) {
        errors.push({ path, message: `Transform error: ${e.message}`, code: 'transform' });
      }
    }

    return { value, errors };
  }

  /** Método principal. Implementado por subclases. */
  _check(value, path) {
    return { value, errors: [] };
  }

  /** Valida el valor completo. */
  validate(value, path = []) {
    // Preprocesar (default/optional/nullable)
    const pre = this._preprocess(value, path);
    if (pre.errors.length > 0) return pre;
    // Valor ya resuelto (default/optional/nullable): no pasar por _check,
    // que rechazaría null/undefined en schemas tipados.
    if (pre.done || pre.value === undefined) return { value: pre.value, errors: [] };

    // Check específico del tipo
    const check = this._check(pre.value, path);

    // Si falla, personalizar mensaje si aplica
    if (check.errors.length > 0 && this._customMessage) {
      check.errors = check.errors.map(e => ({ ...e, message: this._customMessage }));
      return check;
    }

    if (check.errors.length > 0) return check;

    // Postprocesar (refinements + transforms)
    const post = this._postprocess(check.value, path);

    return post;
  }

  /** Parsea o tira error. */
  parse(value) {
    const result = this.validate(value);
    if (result.errors.length > 0) {
      throw new ValidationError(result.errors, value);
    }
    return result.value;
  }

  /** Parsea y devuelve resultado tipo discriminated union. */
  safeParse(value) {
    const result = this.validate(value);
    if (result.errors.length > 0) {
      return { ok: false, errors: result.errors };
    }
    return { ok: true, data: result.value };
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   06 · STRING SCHEMA
   ═══════════════════════════════════════════════════════════════════════════ */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const URL_RE = /^https?:\/\/([\w-]+\.)+[\w-]+(\/[\w\-._~:\/?#[\]@!$&'()*+,;=%]*)?$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;
const IPV6_RE = /^([0-9a-f:]+)$/i;
const PHONE_RE = /^\+?[\d\s\-()]{7,20}$/;

class StringSchema extends BaseSchema {
  constructor() {
    super();
    this._min = null;
    this._max = null;
    this._length = null;
    this._pattern = null;
    this._trim = false;
    this._lowercase = false;
    this._uppercase = false;
    this._email = false;
    this._url = false;
    this._uuid = false;
    this._ip = false;
    this._phone = false;
    this._startsWith = null;
    this._endsWith = null;
    this._includes = null;
    this._nonEmpty = false;
  }

  min(n) { this._min = n; return this; }
  max(n) { this._max = n; return this; }
  length(n) { this._length = n; return this; }
  regex(re, msg) { this._pattern = { re, msg }; return this; }
  pattern(re, msg) { return this.regex(re, msg); }
  trim() { this._trim = true; return this; }
  lowercase() { this._lowercase = true; return this; }
  uppercase() { this._uppercase = true; return this; }
  email() { this._email = true; return this; }
  url() { this._url = true; return this; }
  uuid() { this._uuid = true; return this; }
  ip() { this._ip = true; return this; }
  phone() { this._phone = true; return this; }
  startsWith(s) { this._startsWith = s; return this; }
  endsWith(s) { this._endsWith = s; return this; }
  includes(s) { this._includes = s; return this; }
  nonempty() { this._nonEmpty = true; return this; }

  _check(value, path) {
    const errors = [];

    // Coaccionar
    if (CFG.coerce && typeof value !== 'string') {
      if (typeof value === 'number' || typeof value === 'boolean') {
        value = String(value);
      } else {
        return {
          value,
          errors: [{
            path,
            message: MSG.invalid_type('texto', typeOf(value)),
            code: 'invalid_type',
          }],
        };
      }
    }

    if (typeof value !== 'string') {
      return {
        value,
        errors: [{
          path,
          message: MSG.invalid_type('texto', typeOf(value)),
          code: 'invalid_type',
        }],
      };
    }

    // Transformaciones básicas
    if (this._trim) value = value.trim();
    if (this._lowercase) value = value.toLowerCase();
    if (this._uppercase) value = value.toUpperCase();

    // Longitud
    const len = value.length;

    if (this._nonEmpty && len === 0) {
      errors.push({ path, message: MSG.required, code: 'nonempty' });
    }
    if (this._min !== null && len < this._min) {
      errors.push({ path, message: MSG.string_min(this._min), code: 'string_min' });
    }
    if (this._max !== null && len > this._max) {
      errors.push({ path, message: MSG.string_max(this._max), code: 'string_max' });
    }
    if (this._length !== null && len !== this._length) {
      errors.push({ path, message: MSG.string_length(this._length), code: 'string_length' });
    }

    // Pattern
    if (this._pattern && !this._pattern.re.test(value)) {
      errors.push({
        path,
        message: this._pattern.msg || MSG.string_pattern,
        code: 'string_pattern',
      });
    }

    // Regex específicas
    if (this._email && !EMAIL_RE.test(value)) {
      errors.push({ path, message: MSG.string_email, code: 'string_email' });
    }
    if (this._url && !URL_RE.test(value)) {
      errors.push({ path, message: MSG.string_url, code: 'string_url' });
    }
    if (this._uuid && !UUID_RE.test(value)) {
      errors.push({ path, message: MSG.string_uuid, code: 'string_uuid' });
    }
    if (this._ip) {
      const isV4 = IPV4_RE.test(value) && value.split('.').every(p => parseInt(p, 10) <= 255);
      const isV6 = value.includes(':') && IPV6_RE.test(value);
      if (!isV4 && !isV6) {
        errors.push({ path, message: MSG.string_ip, code: 'string_ip' });
      }
    }
    if (this._phone && !PHONE_RE.test(value)) {
      errors.push({ path, message: MSG.string_phone, code: 'string_phone' });
    }

    // Constraints de contenido
    if (this._startsWith && !value.startsWith(this._startsWith)) {
      errors.push({
        path,
        message: `Debe empezar con "${this._startsWith}"`,
        code: 'string_starts_with',
      });
    }
    if (this._endsWith && !value.endsWith(this._endsWith)) {
      errors.push({
        path,
        message: `Debe terminar con "${this._endsWith}"`,
        code: 'string_ends_with',
      });
    }
    if (this._includes && !value.includes(this._includes)) {
      errors.push({
        path,
        message: `Debe contener "${this._includes}"`,
        code: 'string_includes',
      });
    }

    return { value, errors };
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   07 · NUMBER SCHEMA
   ═══════════════════════════════════════════════════════════════════════════ */

class NumberSchema extends BaseSchema {
  constructor() {
    super();
    this._min = null;
    this._max = null;
    this._int = false;
    this._positive = false;
    this._negative = false;
    this._finite = true;
    this._multipleOf = null;
  }

  min(n) { this._min = n; return this; }
  max(n) { this._max = n; return this; }
  int() { this._int = true; return this; }
  integer() { return this.int(); }
  positive() { this._positive = true; return this; }
  negative() { this._negative = true; return this; }
  finite() { this._finite = true; return this; }
  multipleOf(n) { this._multipleOf = n; return this; }

  _check(value, path) {
    const errors = [];

    // Coaccionar
    if (CFG.coerce && typeof value === 'string') {
      const n = Number(value);
      if (!isNaN(n) && value.trim() !== '') value = n;
    }

    if (typeof value !== 'number') {
      return {
        value,
        errors: [{
          path,
          message: MSG.invalid_type('número', typeOf(value)),
          code: 'invalid_type',
        }],
      };
    }

    if (this._finite && !isFinite(value)) {
      errors.push({ path, message: MSG.number_finite, code: 'number_finite' });
    }
    if (this._int && !Number.isInteger(value)) {
      errors.push({ path, message: MSG.number_int, code: 'number_int' });
    }
    if (this._positive && value <= 0) {
      errors.push({ path, message: MSG.number_positive, code: 'number_positive' });
    }
    if (this._negative && value >= 0) {
      errors.push({ path, message: MSG.number_negative, code: 'number_negative' });
    }
    if (this._min !== null && value < this._min) {
      errors.push({ path, message: MSG.number_min(this._min), code: 'number_min' });
    }
    if (this._max !== null && value > this._max) {
      errors.push({ path, message: MSG.number_max(this._max), code: 'number_max' });
    }
    if (this._multipleOf !== null && value % this._multipleOf !== 0) {
      errors.push({
        path,
        message: `Debe ser múltiplo de ${this._multipleOf}`,
        code: 'number_multiple_of',
      });
    }

    return { value, errors };
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   08 · BOOLEAN SCHEMA
   ═══════════════════════════════════════════════════════════════════════════ */

class BooleanSchema extends BaseSchema {
  constructor() {
    super();
    this._strict = false;
  }

  strict() { this._strict = true; return this; }

  _check(value, path) {
    // Coaccionar
    if (CFG.coerce && typeof value !== 'boolean') {
      if (value === 'true' || value === '1' || value === 1) return { value: true, errors: [] };
      if (value === 'false' || value === '0' || value === 0) return { value: false, errors: [] };
    }

    if (typeof value !== 'boolean') {
      return {
        value,
        errors: [{
          path,
          message: MSG.invalid_type('booleano', typeOf(value)),
          code: 'invalid_type',
        }],
      };
    }

    return { value, errors: [] };
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   09 · DATE SCHEMA
   ═══════════════════════════════════════════════════════════════════════════ */

class DateSchema extends BaseSchema {
  constructor() {
    super();
    this._min = null;
    this._max = null;
    this._asString = false;
    this._asISO = false;
  }

  min(date) { this._min = date instanceof Date ? date : new Date(date); return this; }
  max(date) { this._max = date instanceof Date ? date : new Date(date); return this; }
  asString() { this._asString = true; return this; }
  asISO() { this._asISO = true; return this; }

  _check(value, path) {
    const errors = [];
    let date;

    if (value instanceof Date) {
      date = value;
    } else if (typeof value === 'string' || typeof value === 'number') {
      date = new Date(value);
    } else {
      return {
        value,
        errors: [{
          path,
          message: MSG.invalid_type('fecha', typeOf(value)),
          code: 'invalid_type',
        }],
      };
    }

    if (isNaN(date.getTime())) {
      return {
        value,
        errors: [{ path, message: 'Fecha inválida', code: 'date_invalid' }],
      };
    }

    if (this._min && date < this._min) {
      errors.push({
        path,
        message: `Fecha debe ser después de ${this._min.toISOString()}`,
        code: 'date_min',
      });
    }
    if (this._max && date > this._max) {
      errors.push({
        path,
        message: `Fecha debe ser antes de ${this._max.toISOString()}`,
        code: 'date_max',
      });
    }

    if (errors.length > 0) return { value, errors };

    if (this._asISO) return { value: date.toISOString(), errors: [] };
    if (this._asString) return { value: date.toLocaleString('es-CO'), errors: [] };
    return { value: date, errors: [] };
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   10 · ARRAY SCHEMA
   ═══════════════════════════════════════════════════════════════════════════ */

class ArraySchema extends BaseSchema {
  constructor(itemSchema) {
    super();
    this._itemSchema = itemSchema;
    this._min = null;
    this._max = null;
    this._length = null;
    this._unique = false;
  }

  min(n) { this._min = n; return this; }
  max(n) { this._max = n; return this; }
  length(n) { this._length = n; return this; }
  unique() { this._unique = true; return this; }
  nonempty() { this._min = 1; return this; }

  _check(value, path) {
    const errors = [];

    if (!Array.isArray(value)) {
      return {
        value,
        errors: [{
          path,
          message: MSG.invalid_type('array', typeOf(value)),
          code: 'invalid_type',
        }],
      };
    }

    if (this._min !== null && value.length < this._min) {
      errors.push({ path, message: MSG.array_min(this._min), code: 'array_min' });
    }
    if (this._max !== null && value.length > this._max) {
      errors.push({ path, message: MSG.array_max(this._max), code: 'array_max' });
    }
    if (this._length !== null && value.length !== this._length) {
      errors.push({ path, message: MSG.array_length(this._length), code: 'array_length' });
    }

    if (this._unique) {
      const unique = uniqueArray(value);
      if (unique.length !== value.length) {
        errors.push({ path, message: MSG.array_unique, code: 'array_unique' });
      }
    }

    // Validar cada item
    const out = [];
    if (this._itemSchema) {
      for (let i = 0; i < value.length; i++) {
        const itemPath = [...path, String(i)];
        const itemResult = this._itemSchema.validate(value[i], itemPath);
        if (itemResult.errors.length > 0) {
          errors.push(...itemResult.errors);
        } else {
          out.push(itemResult.value);
        }
      }
    } else {
      out.push(...value);
    }

    return { value: out, errors };
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   11 · OBJECT SCHEMA
   ═══════════════════════════════════════════════════════════════════════════ */

class ObjectSchema extends BaseSchema {
  constructor(shape = {}) {
    super();
    this._shape = shape;
    this._strict = !CFG.stripUnknown; // strict: rechaza campos extras
    this._passthrough = false;
  }

  strict() { this._strict = true; this._passthrough = false; return this; }
  passthrough() { this._strict = false; this._passthrough = true; return this; }
  strip() { this._strict = false; this._passthrough = false; return this; }

  // Extender con más campos
  extend(shape) {
    return new ObjectSchema({ ...this._shape, ...shape });
  }

  // Elegir solo algunos campos
  pick(keys) {
    const shape = {};
    keys.forEach(k => { if (this._shape[k]) shape[k] = this._shape[k]; });
    return new ObjectSchema(shape);
  }

  // Excluir campos
  omit(keys) {
    const shape = { ...this._shape };
    keys.forEach(k => delete shape[k]);
    return new ObjectSchema(shape);
  }

  // Merge con otro object schema
  merge(other) {
    return new ObjectSchema({ ...this._shape, ...other._shape });
  }

  _check(value, path) {
    const errors = [];

    if (!isPlainObject(value)) {
      return {
        value,
        errors: [{
          path,
          message: MSG.invalid_type('objeto', typeOf(value)),
          code: 'invalid_type',
        }],
      };
    }

    const out = {};
    const knownKeys = new Set(Object.keys(this._shape));

    // Validar campos definidos
    for (const [key, schema] of Object.entries(this._shape)) {
      const keyPath = [...path, key];
      const result = schema.validate(value[key], keyPath);

      if (result.errors.length > 0) {
        errors.push(...result.errors);
      } else if (result.value !== undefined) {
        out[key] = result.value;
      }
    }

    // Manejar campos extra
    for (const key of Object.keys(value)) {
      if (knownKeys.has(key)) continue;

      if (this._strict) {
        errors.push({
          path: [...path, key],
          message: `Campo desconocido: "${key}"`,
          code: 'object_unknown_key',
        });
      } else if (this._passthrough) {
        out[key] = value[key];
      }
      // si no es strict ni passthrough → strip silencioso
    }

    return { value: out, errors };
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   12 · ENUM SCHEMA
   ═══════════════════════════════════════════════════════════════════════════ */

class EnumSchema extends BaseSchema {
  constructor(values) {
    super();
    this._values = values;
  }

  _check(value, path) {
    if (!this._values.includes(value)) {
      return {
        value,
        errors: [{
          path,
          message: MSG.enum_invalid(this._values),
          code: 'enum_invalid',
          allowed: this._values,
        }],
      };
    }
    return { value, errors: [] };
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   13 · ANY SCHEMA
   ═══════════════════════════════════════════════════════════════════════════ */

class AnySchema extends BaseSchema {
  _check(value, path) {
    return { value, errors: [] };
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   14 · LITERAL SCHEMA
   ═══════════════════════════════════════════════════════════════════════════ */

class LiteralSchema extends BaseSchema {
  constructor(literal) {
    super();
    this._literal = literal;
  }

  _check(value, path) {
    if (value !== this._literal) {
      return {
        value,
        errors: [{
          path,
          message: `Debe ser exactamente "${this._literal}"`,
          code: 'literal_mismatch',
        }],
      };
    }
    return { value, errors: [] };
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   15 · UNION SCHEMA
   ═══════════════════════════════════════════════════════════════════════════ */

class UnionSchema extends BaseSchema {
  constructor(schemas) {
    super();
    this._schemas = schemas;
  }

  _check(value, path) {
    const allErrors = [];

    for (const schema of this._schemas) {
      const result = schema.validate(value, path);
      if (result.errors.length === 0) {
        return result;
      }
      allErrors.push(...result.errors);
    }

    return {
      value,
      errors: [{
        path,
        message: 'No coincide con ningún tipo permitido',
        code: 'union_no_match',
        details: allErrors.slice(0, 5),
      }],
    };
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   16 · FACTORY · v
   ═══════════════════════════════════════════════════════════════════════════ */

const v = {
  string: () => new StringSchema(),
  number: () => new NumberSchema(),
  boolean: () => new BooleanSchema(),
  date: () => new DateSchema(),
  array: (itemSchema) => new ArraySchema(itemSchema),
  object: (shape) => new ObjectSchema(shape || {}),
  enum: (values) => new EnumSchema(values),
  any: () => new AnySchema(),
  literal: (literal) => new LiteralSchema(literal),
  union: (schemas) => new UnionSchema(schemas),

  // Shorthands
  email: () => new StringSchema().email(),
  url: () => new StringSchema().url(),
  uuid: () => new StringSchema().uuid(),
  ip: () => new StringSchema().ip(),
  phone: () => new StringSchema().phone(),

  // Aliases
  int: () => new NumberSchema().int(),
  float: () => new NumberSchema(),
};

/* ═══════════════════════════════════════════════════════════════════════════
   17 · API DE ALTO NIVEL
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Valida data contra un schema. Devuelve resultado estructurado.
 */
function validate(schema, data) {
  if (!schema || typeof schema.validate !== 'function') {
    return {
      ok: false,
      errors: [{ path: [], message: 'Schema inválido', code: 'invalid_schema' }],
    };
  }

  const result = schema.validate(data);

  if (CFG.debug) {
    log.debug('validate', {
      ok: result.errors.length === 0,
      errors: result.errors.length,
    });
  }

  if (result.errors.length > 0) {
    return {
      ok: false,
      errors: result.errors.slice(0, CFG.maxErrors),
    };
  }

  return { ok: true, data: result.value };
}

/**
 * Igual que validate pero tira ValidationError si falla.
 */
function validateOrThrow(schema, data) {
  const result = validate(schema, data);
  if (!result.ok) {
    throw new ValidationError(result.errors, data);
  }
  return result.data;
}

/**
 * Middleware Express que valida req.body contra un schema.
 * Deja el resultado en req.validated y sigue.
 * Si falla, responde 400 con los errores.
 *
 *   app.post('/api/chat', middleware(ChatSchema), handler);
 */
function middleware(schema, options = {}) {
  const source = options.source || 'body'; // body | query | params
  const target = options.target || 'validated';
  const onError = options.onError;

  return function validatorMiddleware(req, res, next) {
    const data = req[source];

    const result = validate(schema, data);

    if (result.ok) {
      req[target] = result.data;
      return next();
    }

    // Personalizar respuesta
    if (typeof onError === 'function') {
      return onError(result.errors, req, res, next);
    }

    const body = {
      ok: false,
      error: result.errors[0].message,
      code: 'VALIDATION_ERROR',
      errors: CFG.errorMode === 'all' ? result.errors : [result.errors[0]],
    };

    log.debug('validation failed', {
      reqId: req.id,
      path: req.path,
      errors: result.errors.length,
    });

    return res.status(400).json(body);
  };
}

/**
 * Middleware que valida múltiples fuentes a la vez.
 *
 *   middlewareMany({
 *     body: SchemaBody,
 *     query: SchemaQuery,
 *     params: SchemaParams,
 *   })
 */
function middlewareMany(schemas, options = {}) {
  return function validatorManyMiddleware(req, res, next) {
    const errors = [];
    req.validated = req.validated || {};

    for (const [source, schema] of Object.entries(schemas)) {
      const data = req[source];
      const result = validate(schema, data);

      if (result.ok) {
        req.validated[source] = result.data;
      } else {
        errors.push(...result.errors.map(e => ({
          ...e,
          path: [source, ...e.path],
        })));
      }
    }

    if (errors.length > 0) {
      return res.status(400).json({
        ok: false,
        error: errors[0].message,
        code: 'VALIDATION_ERROR',
        errors: CFG.errorMode === 'all' ? errors : [errors[0]],
      });
    }

    next();
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   18 · SCHEMAS PRE-CONSTRUIDOS DE NUMINATION
   ═══════════════════════════════════════════════════════════════════════════ */

const SCHEMAS = {
  // Chat message
  chatMessage: v.object({
    message: v.string().min(1).max(8000),
    role: v.enum(['student', 'teacher', 'reasoning']).default('student'),
    file: v.object({
      name: v.string().max(255).optional(),
      data: v.string().optional(),
      type: v.string().optional(),
    }).optional().nullable(),
    incognito: v.boolean().default(false),
    history: v.array(v.object({
      role: v.enum(['user', 'assistant']),
      content: v.string().max(50000),
    })).max(50).optional().default([]),
    webSearch: v.boolean().default(false),
    chatId: v.uuid().optional().nullable(),
  }),

  // Autenticación
  login: v.object({
    email: v.email().max(200),
    password: v.string().min(8).max(200),
  }),

  register: v.object({
    email: v.email().max(200),
    password: v.string().min(8).max(200),
    name: v.string().min(2).max(80).optional(),
  }),

  // Perfil
  profileUpdate: v.object({
    name: v.string().min(2).max(80).optional(),
    pronouns: v.string().max(40).optional().nullable(),
  }),

  // Memoria
  memoryCreate: v.object({
    title: v.string().min(1).max(200),
    content: v.string().max(5000).optional(),
  }),

  // Proyecto
  projectCreate: v.object({
    name: v.string().min(1).max(80),
    description: v.string().max(500).optional().nullable(),
  }),

  // Paginación
  pagination: v.object({
    limit: v.number().int().min(1).max(100).default(20),
    offset: v.number().int().min(0).default(0),
  }),

  // ID simple
  idParam: v.object({
    id: v.uuid(),
  }),
};

/* ═══════════════════════════════════════════════════════════════════════════
   19 · SELF-TEST
   ═══════════════════════════════════════════════════════════════════════════ */

async function test() {
  const results = [];
  const rec = (name, ok, detail) => results.push({ name, ok, detail });

  // Strings
  rec('string válido', v.string().min(2).validate('hola').errors.length === 0, true);
  rec('string muy corto falla', v.string().min(5).validate('hi').errors.length > 0, true);
  rec('string muy largo falla', v.string().max(3).validate('hola').errors.length > 0, true);
  rec('string length exacto', v.string().length(4).validate('hola').errors.length === 0, true);
  rec('string trim', v.string().trim().validate(' hola ').value === 'hola', true);
  rec('string lowercase', v.string().lowercase().validate('HOLA').value === 'hola', true);

  // Coacción
  rec('string coacciona número', v.string().validate(42).value === '42', true);
  rec('number coacciona string', v.number().validate('42').value === 42, true);
  rec('boolean coacciona "true"', v.boolean().validate('true').value === true, true);
  rec('boolean coacciona 0', v.boolean().validate(0).value === false, true);

  // Email
  rec('email válido', v.email().validate('a@b.com').errors.length === 0, true);
  rec('email inválido', v.email().validate('not-email').errors.length > 0, true);

  // URL
  rec('url válida', v.url().validate('https://example.com').errors.length === 0, true);
  rec('url inválida', v.url().validate('not-url').errors.length > 0, true);

  // UUID
  const uuid = '123e4567-e89b-12d3-a456-426614174000';
  rec('uuid válido', v.uuid().validate(uuid).errors.length === 0, true);
  rec('uuid inválido', v.uuid().validate('abc').errors.length > 0, true);

  // IP
  rec('ip v4 válida', v.ip().validate('8.8.8.8').errors.length === 0, true);
  rec('ip inválida', v.ip().validate('not-ip').errors.length > 0, true);

  // Number
  rec('number min', v.number().min(5).validate(3).errors.length > 0, true);
  rec('number int rechaza float', v.number().int().validate(3.5).errors.length > 0, true);
  rec('number positive', v.number().positive().validate(-1).errors.length > 0, true);

  // Boolean
  rec('boolean true', v.boolean().validate(true).errors.length === 0, true);
  rec('boolean rechaza string random', v.boolean().validate('foo').errors.length > 0, true);

  // Enum
  rec('enum válido', v.enum(['a', 'b']).validate('a').errors.length === 0, true);
  rec('enum inválido', v.enum(['a', 'b']).validate('c').errors.length > 0, true);

  // Array
  rec('array válido', v.array(v.number()).validate([1, 2, 3]).errors.length === 0, true);
  rec('array valida items', v.array(v.number()).validate([1, 'x', 3]).errors.length > 0, true);
  rec('array min', v.array(v.number()).min(2).validate([1]).errors.length > 0, true);
  rec('array unique', v.array(v.number()).unique().validate([1, 1, 2]).errors.length > 0, true);

  // Object
  const objSchema = v.object({
    name: v.string().min(1),
    age: v.number().int().min(0),
  });
  rec('object válido', objSchema.validate({ name: 'Juan', age: 25 }).errors.length === 0, true);
  rec('object missing field', objSchema.validate({ name: 'Juan' }).errors.length > 0, true);
  rec('object coacciona', objSchema.validate({ name: 'Juan', age: '25' }).value.age === 25, true);

  // Object strip unknown
  const stripped = objSchema.validate({ name: 'Juan', age: 25, extra: 'x' });
  rec('object strip unknown', stripped.value.extra === undefined, true);

  // Object strict
  const strict = v.object({ a: v.string() }).strict();
  rec('object strict rechaza extra', strict.validate({ a: 'x', b: 'y' }).errors.length > 0, true);

  // Optional / nullable / default
  const optSchema = v.object({
    a: v.string().optional(),
    b: v.number().nullable(),
    c: v.boolean().default(true),
  });
  const optResult = optSchema.validate({});
  rec('optional permite undefined', optResult.errors.length === 0, true);
  rec('nullable permite null', optResult.value.b === null, true);
  rec('default aplica', optResult.value.c === true, true);

  // Union (en modo estricto: la coerción global convertiría true→"true")
  const prevCoerce = CFG.coerce;
  CFG.coerce = false;
  const union = v.union([v.string(), v.number()]);
  rec('union acepta string', union.validate('hola').errors.length === 0, true);
  rec('union acepta number', union.validate(42).errors.length === 0, true);
  rec('union rechaza boolean', union.validate(true).errors.length > 0, true);
  CFG.coerce = prevCoerce;

  // Literal
  rec('literal match', v.literal('x').validate('x').errors.length === 0, true);
  rec('literal no match', v.literal('x').validate('y').errors.length > 0, true);

  // Transform
  const upper = v.string().transform(s => s.toUpperCase());
  rec('transform aplica', upper.validate('hola').value === 'HOLA', true);

  // Refine
  const even = v.number().refine(n => n % 2 === 0, 'Debe ser par');
  rec('refine pasa', even.validate(4).errors.length === 0, true);
  rec('refine falla', even.validate(3).errors.length > 0, true);

  // validate() helper
  const r1 = validate(v.string().min(1), 'hola');
  rec('validate ok', r1.ok === true && r1.data === 'hola', true);
  const r2 = validate(v.string().min(10), 'hi');
  rec('validate fail', r2.ok === false && r2.errors.length > 0, true);

  // validateOrThrow
  let threw = false;
  try { validateOrThrow(v.string().min(10), 'hi'); } catch (e) { threw = e.isValidationError === true; }
  rec('validateOrThrow tira', threw === true, true);

  // Schema de chat real
  const chatTest = validate(SCHEMAS.chatMessage, { message: 'Hola' });
  rec('SCHEMAS.chatMessage válido', chatTest.ok === true && chatTest.data.role === 'student', chatTest);

  const chatInvalid = validate(SCHEMAS.chatMessage, {});
  rec('SCHEMAS.chatMessage rechaza vacío', chatInvalid.ok === false, true);

  // Extend / pick / omit
  const base = v.object({ a: v.string(), b: v.number() });
  const extended = base.extend({ c: v.boolean() });
  rec('extend agrega campo', extended.validate({ a: 'x', b: 1, c: true }).errors.length === 0, true);

  const picked = base.pick(['a']);
  rec('pick reduce campos', picked.validate({ a: 'x' }).errors.length === 0, true);

  const omitted = base.omit(['b']);
  rec('omit quita campo', omitted.validate({ a: 'x' }).errors.length === 0, true);

  const passed = results.filter(r => r.ok).length;
  return {
    passed,
    total: results.length,
    ok: passed === results.length,
    results,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   20 · CONFIGURACIÓN RUNTIME
   ═══════════════════════════════════════════════════════════════════════════ */

function configure(patch) {
  if (!patch || typeof patch !== 'object') return;
  Object.assign(CFG, patch);
}

/* ═══════════════════════════════════════════════════════════════════════════
   21 · EXPORTS
   ═══════════════════════════════════════════════════════════════════════════ */

export {
  v,
  validate,
  validateOrThrow,
  middleware,
  middlewareMany,
  ValidationError,
  SCHEMAS,
  configure,
  test,
};

export default {
  v,
  validate,
  validateOrThrow,
  middleware,
  middlewareMany,
  ValidationError,
  SCHEMAS,
  configure,
  test,
};