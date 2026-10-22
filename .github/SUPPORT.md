# Soporte de Numination

¿Necesitas ayuda? Estás en el lugar correcto. Esta guía te dice **dónde** preguntar y **cómo** hacerlo para que recibas una respuesta útil lo antes posible.

> **Antes de abrir un issue:** busca en la documentación, en los issues existentes y en las discusiones. La mayoría de las dudas ya tienen respuesta.

---

## 1. Elige el canal correcto

| Necesitas… | Canal | Tiempo esperado |
|---|---|---|
| Reportar un bug reproducible | [Issue con plantilla](https://github.com/trivoren/Numination/issues/new?template=bug_report.md) | Triaje en 2–5 días hábiles |
| Preguntar cómo hacer algo | [GitHub Discussions](https://github.com/trivoren/Numination/discussions) | Respuesta comunitaria |
| Hablar con otras personas | [Discord de Numination](https://discord.gg/numination) | Tiempo real, mejor esfuerzo |
| Leer documentación | [docs/README.md](../docs/README.md) | Autoservicio |
| Reportar una vulnerabilidad | [security@numination.com](mailto:security@numination.com) | Acuse en ≤ 48 h |
| Reportar conducta inapropiada | [conduct@numination.com](mailto:conduct@numination.com) | Acuse en ≤ 48 h |
| Problema de cuenta o facturación | [soporte@numination.app](mailto:soporte@numination.app) | 1–3 días hábiles |
| Emergencia de producción | [security@numination.com](mailto:security@numination.com) con asunto `[URGENTE]` | Prioridad alta |

---

## 2. Bug vs. pregunta

### 2.1 Es un bug si…

- La aplicación hace algo distinto de lo documentado.
- Un endpoint devuelve un error inesperado de forma reproducible.
- La interfaz se rompe, pierde datos o muestra información incorrecta.
- Una migración falla en un entorno limpio.
- Los tests fallan en `main`.
- Hay una regresión después de una actualización.

👉 Abre un **[Bug Report](https://github.com/trivoren/Numination/issues/new?template=bug_report.md)**.

Un buen reporte incluye:

1. Descripción clara y concisa.
2. Pasos exactos para reproducir.
3. Comportamiento esperado vs. actual.
4. Capturas o logs **sin secretos ni datos personales**.
5. Entorno: sistema operativo, versión de Node, navegador, versión de Numination.
6. Si aplica, el commit o release donde ocurre.

### 2.2 Es una pregunta si…

- No sabes cómo configurar una variable de entorno.
- Quieres entender cómo funciona el RAG, el Coder o la cascada de IA.
- Necesitas ayuda para integrar la API.
- Tienes una idea que aún no es una propuesta formal.
- Quieres compartir cómo usas Numination.
- Buscas orientación sobre arquitectura o mejores prácticas.

👉 Usa **[GitHub Discussions](https://github.com/trivoren/Numination/discussions)** o el **[Discord](https://discord.gg/numination)**.

Las preguntas en issues serán redirigidas a Discussions para mantener el tracker enfocado en bugs accionables.

### 2.3 No es ninguno de los dos

- **Vulnerabilidad de seguridad:** no abras un issue. Sigue [SECURITY.md](../SECURITY.md).
- **Acoso o conducta inapropiada:** sigue [CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md).
- **Solicitud de feature:** abre una discusión en la categoría *Ideas* antes de convertirla en issue.
- **Publicidad, spam o reclutamiento:** no está permitido en los canales del proyecto.

---

## 3. Documentación

Antes de preguntar, revisa estos documentos:

| Tema | Documento |
|---|---|
| Índice general | [docs/README.md](../docs/README.md) |
| Instalación y variables | [docs/installation.md](../docs/installation.md) |
| Arquitectura y flujos | [docs/architecture.md](../docs/architecture.md) |
| API y endpoints | [docs/api-reference.md](../docs/api-reference.md) |
| Base de datos y RLS | [docs/database-schema.md](../docs/database-schema.md) |
| Orquestación de IA | [docs/ai-orchestration.md](../docs/ai-orchestration.md) |
| Módulo Coder | [docs/coder-module.md](../docs/coder-module.md) |
| Memoria y pgvector | [docs/memory-system.md](../docs/memory-system.md) |
| Pagos y webhooks | [docs/payment-flow.md](../docs/payment-flow.md) |
| Seguridad | [docs/security.md](../docs/security.md) |
| Deploy en Vercel | [docs/deployment.md](../docs/deployment.md) |
| Problemas comunes | [docs/troubleshooting.md](../docs/troubleshooting.md) |
| Roadmap | [docs/roadmap.md](../docs/roadmap.md) |
| Contribuir | [CONTRIBUTING.md](../CONTRIBUTING.md) |

### 3.1 Diagnóstico rápido

```bash
# Versión de Node
node --version

# Estado del servidor
curl -s http://localhost:8080/api/health

# Versión desplegada
curl -s http://localhost:8080/api/version

# Estado de migraciones
npm run migrate:status

# Tests
npm test
```

Si el health check falla, revisa:

1. Que `env.local.js` exista y tenga `DATABASE_URL` y `JWT_SECRET`.
2. Que PostgreSQL esté accesible.
3. Que el puerto `8080` no esté ocupado.
4. Los logs del proceso, no solo la respuesta HTTP.

---

## 4. Comunidad

### Discord

Únete al **[Discord de Numination](https://discord.gg/numination)** para:

- Ayuda rápida de otros usuarios.
- Anuncios de releases.
- Discusión de ideas y roadmap.
- Soporte entre pares.

Canales recomendados:

| Canal | Uso |
|---|---|
| `#ayuda` | Preguntas técnicas generales |
| `#bugs` | Confirmar si algo es un bug antes de abrir issue |
| `#ideas` | Propuestas y feedback |
| `#anuncios` | Releases y cambios importantes |
| `#contribuidores` | Coordinación de PRs |

Normas del Discord:

- Respeta el [Código de Conducta](../CODE_OF_CONDUCT.md).
- No compartas secretos, tokens ni datos personales.
- No hagas spam ni autopromoción.
- Usa el canal adecuado.
- No pidas soporte por mensaje directo a mantenedores sin invitación.

### GitHub Discussions

Ideal para preguntas que pueden ayudar a otras personas en el futuro. Categorías sugeridas:

- **Q&A:** dudas técnicas.
- **Ideas:** propuestas de funcionalidad.
- **Show and tell:** proyectos construidos con Numination.
- **Announcements:** novedades del equipo.

---

## 5. Cómo escribir una buena pregunta

Una buena pregunta ahorra tiempo a todos. Incluye:

```markdown
## Contexto
Qué intentas lograr y por qué.

## Qué probé
Comandos, configuración y pasos exactos.

## Resultado esperado
Qué debería pasar.

## Resultado actual
Qué pasa realmente, con el error completo.

## Entorno
- OS:
- Node:
- Navegador:
- Versión de Numination:
- Commit:

## Evidencia
Logs o capturas sin secretos.
```

Evita:

- “No funciona” sin contexto.
- Capturas de texto cuando puedes pegar el error.
- Múltiples problemas en un solo hilo.
- Etiquetar a mantenedores para acelerar una respuesta.
- Publicar tokens, contraseñas o cadenas de conexión.

---

## 6. Tiempos de respuesta

Numination es mantenido por un equipo pequeño. Los tiempos son objetivos de buena fe:

| Canal | Primera respuesta |
|---|---|
| Issue de bug | 2–5 días hábiles |
| Discussions | 1–5 días hábiles, según disponibilidad |
| Discord | Mejor esfuerzo, sin garantía |
| Correo de soporte | 1–3 días hábiles |
| Seguridad | ≤ 48 horas |
| Conducta | ≤ 48 horas |

Los fines de semana y feriados pueden aumentar los tiempos. La ausencia de respuesta no significa rechazo; revisa el estado del issue y, si es urgente, añade información nueva en lugar de duplicar el reporte.

---

## 7. Qué no hacemos por soporte

- No depuramos aplicaciones de terceros que consumen la API.
- No gestionamos cuentas de PayPal, Google, GitHub o Supabase por ti.
- No recuperamos contraseñas manualmente; usa el flujo de reset.
- No damos asesoría legal, fiscal ni de cumplimiento.
- No garantizamos compatibilidad con versiones fuera de soporte.
- No atendemos solicitudes de eliminar datos por canales públicos.
- No revelamos detalles internos de seguridad de otros usuarios.

Para asuntos de privacidad, escribe a [privacidad@numination.app](mailto:privacidad@numination.app).

---

## 8. Antes de abrir un issue: checklist

- [ ] Leí la documentación relevante.
- [ ] Busqué en issues y discussions existentes.
- [ ] Reproduje el problema en la última versión.
- [ ] Probé en un entorno limpio cuando fue posible.
- [ ] Incluí pasos exactos para reproducir.
- [ ] Incluí el error completo y los logs relevantes.
- [ ] Eliminé secretos, tokens y datos personales.
- [ ] Indiqué sistema operativo, Node, navegador y versión.
- [ ] El título describe el problema en una frase.
- [ ] Es un bug, no una pregunta.

---

## 9. Seguridad y privacidad

- **Nunca** publiques credenciales, tokens, cookies o cadenas de conexión.
- **Nunca** publiques datos personales de otras personas.
- **Nunca** publiques exploits funcionales en issues públicos.
- Si compartiste un secreto por error, rótalo de inmediato y avísanos.
- Los reportes de seguridad siguen el proceso de [SECURITY.md](../SECURITY.md).

---

## 10. Contacto

| Propósito | Contacto |
|---|---|
| Soporte general | [soporte@numination.app](mailto:soporte@numination.app) |
| Seguridad | [security@numination.com](mailto:security@numination.com) |
| Conducta | [conduct@numination.com](mailto:conduct@numination.com) |
| Privacidad | [privacidad@numination.app](mailto:privacidad@numination.app) |
| Repositorio | <https://github.com/trivoren/Numination> |
| Documentación | [docs/README.md](../docs/README.md) |
| Discord | <https://discord.gg/numination> |

---

Gracias por ayudar a que Numination sea mejor. Una pregunta bien escrita vale más que diez mensajes de “no funciona”.
