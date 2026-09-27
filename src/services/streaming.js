/* ============================================================
   Streaming de respuestas IA
   Emite tokens en tiempo real vía async generator.
   Soporta modo razonamiento (envuelve la respuesta en <thinking>).
   ============================================================ */

const REASONING_PREFIX = `INSTRUCCIÓN ESPECIAL — MODO RAZONAMIENTO:

Piensa paso a paso ANTES de responder. Todo tu proceso mental DEBE ir envuelto exactamente entre las etiquetas <thinking> y </thinking>. Después del cierre </thinking>, escribe la respuesta final limpia y directa para el estudiante.

Formato EXACTO:
<thinking>
1. Primero identifico...
2. Luego considero...
3. Finalmente concluyo...
</thinking>

[Tu respuesta final aquí, sin repetir el razonamiento]

REGLAS:
- NO repitas el contenido del razonamiento en la respuesta final.
- Sé breve en la respuesta final, detallado en el razonamiento.
- Usa ejemplos de Colombia cuando aplique.
- Nunca hagas la tarea por el estudiante — guíalo.

PREGUNTA DEL ESTUDIANTE:
`;

export async function* streamGroq(groq, systemPrompt, message, file, opts = {}) {
  const note = file && file.data
    ? '\n\n[El usuario adjuntó un archivo. Responde con la información disponible.]'
    : '';

  const base = message || (opts.reasoning ? '' : '(sin texto)');
  const userContent = opts.reasoning
    ? REASONING_PREFIX + base + note
    : base + note;

  const stream = await groq.chat.completions.create({
    model: 'openai/gpt-oss-120b',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
    temperature: opts.reasoning ? 0.5 : 0.7,
    max_tokens: opts.reasoning ? 4096 : 2048,
    stream: true,
  });

  for await (const chunk of stream) {
    const token = chunk.choices?.[0]?.delta?.content;
    if (token) yield token;
  }
}

export async function* streamGemini(gemini, systemPrompt, message, file, opts = {}) {
  const baseText = message || (file && file.data ? '(analiza el archivo adjunto)' : '');
  const parts = [{ text: opts.reasoning ? REASONING_PREFIX + baseText : baseText }];

  if (file && file.data) {
    parts.push({ inlineData: { mimeType: file.mimeType, data: file.data } });
  }

  const stream = await gemini.models.generateContentStream({
    model: 'gemini-3.6-flash',
    contents: [{ role: 'user', parts }],
    config: {
      systemInstruction: systemPrompt,
      // En modo razonamiento SÍ activamos el thinking nativo de Gemini
      thinkingConfig: opts.reasoning
        ? { thinkingBudget: 2000 }
        : { thinkingBudget: 0 },
      temperature: opts.reasoning ? 0.5 : 0.7,
      maxOutputTokens: opts.reasoning ? 4096 : 2048,
    },
  });

  for await (const chunk of stream) {
    if (chunk.text) yield chunk.text;
  }
}