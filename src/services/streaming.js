/* ============================================================
   Streaming de respuestas IA
   Emite tokens en tiempo real vía async generator.
   ============================================================ */

export async function* streamGroq(groq, systemPrompt, message, file) {
  const note = file && file.data
    ? '\n\n[El usuario adjuntó un archivo. Responde con la información disponible.]'
    : '';

  const stream = await groq.chat.completions.create({
    model: 'openai/gpt-oss-120b',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: (message || '(sin texto)') + note },
    ],
    temperature: 0.7,
    max_tokens: 2048,
    stream: true,
  });

  for await (const chunk of stream) {
    const token = chunk.choices?.[0]?.delta?.content;
    if (token) yield token;
  }
}

export async function* streamGemini(gemini, systemPrompt, message, file) {
  const parts = [{ text: message || '(analiza el archivo adjunto)' }];
  if (file && file.data) {
    parts.push({ inlineData: { mimeType: file.mimeType, data: file.data } });
  }

  const stream = await gemini.models.generateContentStream({
    model: 'gemini-3.6-flash',
    contents: [{ role: 'user', parts }],
    config: { systemInstruction: systemPrompt },
  });

  for await (const chunk of stream) {
    if (chunk.text) yield chunk.text;
  }
}