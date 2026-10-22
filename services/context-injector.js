/* ═══════════════════════════════════════════════════════════════════════
   NUMINATION · services/context-injector.js · v1.0
   ───────────────────────────────────────────────────────────────────────
   Ensambla el System Prompt final a partir de tres fuentes:
     · Persona   → quién es el asistente y cómo habla.
     · RAG       → fragmentos recuperados de los documentos del usuario.
     · Historial → conversación reciente ya resumida.

   PRESUPUESTO DE TOKENS
     El presupuesto (`maxTokens`) se reparte en porcentajes fijos:
       30 % persona · 40 % RAG · 30 % historial.
     Cada sección se recorta a su cuota (estimación ≈4 caracteres/token)
     y si aun así se pasa, se recorta primero el historial — el RAG es
     lo último que se sacrifica porque suele contener los datos duros.

   CONTRATO
     buildContextPrompt({ persona, rag, history, maxTokens })
       → { systemPrompt, sections, tokens, truncated }
   ═══════════════════════════════════════════════════════════════════════ */

import { LOG } from '../src/lib/logger.js';

/* ═══════════════════════════════════════════════════════════════════════
   01 · CONFIGURACIÓN
   ═══════════════════════════════════════════════════════════════════════ */

const CFG = Object.freeze({
  charsPerToken: 4,
  defaultMaxTokens: 4000,
  weights: Object.freeze({ persona: 0.3, rag: 0.4, history: 0.3 }),
  header: 'Eres el asistente de Numination.',
});

/* ═══════════════════════════════════════════════════════════════════════
   02 · UTILIDADES
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Estimación de tokens por longitud.
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  const value = String(text ?? '');
  if (!value) return 0;
  return Math.ceil(value.length / CFG.charsPerToken);
}

/**
 * Recorta un texto a un máximo de tokens, cortando por líneas.
 * @param {string} text
 * @param {number} maxTokens
 * @returns {{text:string, truncated:boolean, tokens:number}}
 */
export function truncateToTokens(text, maxTokens) {
  const value = String(text ?? '');
  const limit = Math.max(0, Math.floor(maxTokens));
  const maxChars = limit * CFG.charsPerToken;

  if (!limit) return { text: '', truncated: value.length > 0, tokens: 0 };
  if (value.length <= maxChars) {
    return { text: value, truncated: false, tokens: estimateTokens(value) };
  }

  const sliced = value.slice(0, maxChars);
  const lastBreak = sliced.lastIndexOf('\n');
  const cut = lastBreak > maxChars * 0.6 ? sliced.slice(0, lastBreak) : sliced;

  return {
    text: `${cut.trim()}\n[…contenido recortado por límite de tokens]`,
    truncated: true,
    tokens: estimateTokens(cut),
  };
}

/**
 * Normaliza el historial a texto plano.
 * @param {Array} history
 * @returns {string}
 */
export function historyToText(history) {
  if (!Array.isArray(history)) return '';
  return history
    .map((m) => {
      const role = m?.role === 'assistant' || m?.role === 'ai' ? 'Assistant' : 'User';
      const content = String(m?.content ?? '').trim();
      return content ? `${role}: ${content}` : '';
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * Normaliza los fragmentos RAG a texto plano.
 * @param {Array|string} rag
 * @returns {string}
 */
export function ragToText(rag) {
  if (!rag) return '';
  if (typeof rag === 'string') return rag.trim();
  if (!Array.isArray(rag)) return '';

  return rag
    .map((chunk, i) => {
      if (typeof chunk === 'string') return `[${i + 1}] ${chunk.trim()}`;
      const title = chunk.title || chunk.source || chunk.file || `Fragmento ${i + 1}`;
      const content = String(chunk.content ?? chunk.text ?? '').trim();
      const score = Number.isFinite(chunk.score) ? ` (score ${chunk.score.toFixed(3)})` : '';
      return content ? `[${i + 1}] ${title}${score}\n${content}` : '';
    })
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Normaliza la persona a texto plano.
 * @param {object|string} persona
 * @returns {string}
 */
export function personaToText(persona) {
  if (!persona) return '';
  if (typeof persona === 'string') return persona.trim();
  if (typeof persona !== 'object') return '';

  const lines = [];
  if (persona.name) lines.push(`Nombre: ${persona.name}`);
  if (persona.role || persona.profession) {
    lines.push(`Rol: ${persona.role || persona.profession}`);
  }
  if (persona.description) lines.push(`Descripción: ${persona.description}`);
  if (persona.tone) lines.push(`Tono: ${persona.tone}`);
  if (persona.style) lines.push(`Estilo: ${persona.style}`);
  if (persona.language) lines.push(`Idioma: ${persona.language}`);
  if (persona.instructions) lines.push(`Instrucciones: ${persona.instructions}`);
  if (Array.isArray(persona.rules) && persona.rules.length) {
    lines.push(`Reglas:\n- ${persona.rules.join('\n- ')}`);
  }

  return lines.join('\n').trim();
}

/* ═══════════════════════════════════════════════════════════════════════
   03 · ENSAMBLADO
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Construye el System Prompt final.
 *
 * @param {object}  params
 * @param {object|string} [params.persona]  Personalidad del asistente.
 * @param {Array|string}   [params.rag]     Fragmentos recuperados.
 * @param {Array}          [params.history] Historial reciente.
 * @param {number}         [params.maxTokens]
 * @param {string}         [params.header]  Cabecera del system prompt.
 * @returns {{systemPrompt:string, sections:object, tokens:number, truncated:boolean}}
 */
export function buildContextPrompt(params = {}) {
  const {
    persona,
    rag,
    history,
    maxTokens = CFG.defaultMaxTokens,
    header = CFG.header,
  } = params;

  const budget = Math.max(256, Math.floor(Number(maxTokens) || CFG.defaultMaxTokens));

  const raw = {
    persona: personaToText(persona),
    rag: ragToText(rag),
    history: historyToText(history),
  };

  const quota = {
    persona: Math.floor(budget * CFG.weights.persona),
    rag: Math.floor(budget * CFG.weights.rag),
    history: Math.floor(budget * CFG.weights.history),
  };

  const clipped = {
    persona: truncateToTokens(raw.persona, quota.persona),
    rag: truncateToTokens(raw.rag, quota.rag),
    history: truncateToTokens(raw.history, quota.history),
  };

  // Si el conjunto sigue pasando del presupuesto, se recorta el historial
  // (es lo más prescindible) y, en último caso, el RAG.
  let overflow = Object.values(clipped).reduce((acc, s) => acc + s.tokens, 0) - budget;
  if (overflow > 0) {
    clipped.history = truncateToTokens(
      clipped.history.text,
      Math.max(0, clipped.history.tokens - overflow)
    );
    overflow = Object.values(clipped).reduce((acc, s) => acc + s.tokens, 0) - budget;
  }
  if (overflow > 0) {
    clipped.rag = truncateToTokens(
      clipped.rag.text,
      Math.max(0, clipped.rag.tokens - overflow)
    );
  }

  const parts = [String(header).trim()];
  if (clipped.persona.text) {
    parts.push(`# Identidad\n${clipped.persona.text}`);
  }
  if (clipped.rag.text) {
    parts.push(
      `# Contexto recuperado (RAG)\nUsa sólo esta información para los datos concretos:\n${clipped.rag.text}`
    );
  }
  if (clipped.history.text) {
    parts.push(`# Conversación reciente\n${clipped.history.text}`);
  }

  const systemPrompt = parts.join('\n\n');
  const tokens = estimateTokens(systemPrompt);

  if (tokens > budget) {
    LOG.warn('context-injector: el prompt supera el presupuesto', { tokens, budget });
  }

  return {
    systemPrompt,
    sections: {
      persona: clipped.persona,
      rag: clipped.rag,
      history: clipped.history,
    },
    tokens,
    truncated: Object.values(clipped).some((s) => s.truncated),
  };
}

export default {
  buildContextPrompt,
  estimateTokens,
  truncateToTokens,
  personaToText,
  ragToText,
  historyToText,
};
