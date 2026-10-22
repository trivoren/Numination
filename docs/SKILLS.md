# 🛡️ SKILLS DE ESCRITURA Y LEGALES SELECCIONADAS

| # | Skill | Dominio | Por qué se seleccionó | Documento(s) donde se aplicó |
|---|---|---|---|---|
| 1 | **technical-writer** | Redacción técnica | Garantiza prosa precisa, sin relleno, con estructura de referencia y no de blog. Base de tono para toda la carpeta. | Todos |
| 2 | **documentation-engineer** | Ingeniería documental | Aporta verificación contra código real, control de vigencia y consistencia entre documentos enlazados. | `README.md`, `architecture.md`, `installation.md` |
| 3 | **api-documenter** | Documentación de API | Fuerza contratos completos: método, auth, body, códigos de error y ejemplos ejecutables en `curl`. | `api-reference.md` |
| 4 | **legal-advisor** | Análisis legal | Estructura la delimitación de responsabilidad, jurisdicción, indemnidad y cláusulas de cumplimiento. | `LICENSE.md` |
| 5 | **license-engineer** | Arquitectura de licencias | Distingue correctamente software propietario de licencias permisivas/copyleft y define el alcance de los derechos reservados. | `LICENSE.md`, `contributing.md` |
| 6 | **readme-generator** | Documentación de entrada | Obliga a que cada comando, ruta y variable citada exista de verdad en el repositorio. | `README.md`, `installation.md` |
| 7 | **architect-reviewer** | Revisión de arquitectura | Expone acoplamientos, límites de capa, deuda técnica y riesgos de escalabilidad sin maquillarlos. | `architecture.md`, `deployment.md`, `roadmap.md` |
| 8 | **llm-architect** | Arquitectura de IA | Permite describir con rigor la cascada de proveedores, rotación de claves, presupuesto de contexto y evaluación. | `ai-orchestration.md`, `memory-system.md` |
| 9 | **content-quality-editor** | Edición de calidad | Elimina patrones de escritura generada, redundancias y afirmaciones sin respaldo antes de publicar. | Todos |
| 10 | **api-designer** | Diseño de contratos | Valida consistencia de envelope, códigos estables, paginación, idempotencia y versionado futuro. | `api-reference.md`, `payment-flow.md` |

---

## Cómo se aplicaron

| Fase | Skills activas | Resultado |
|---|---|---|
| Reconocimiento del código | `architect-reviewer`, `documentation-engineer` | Mapa real de ~100 archivos, 78 endpoints y 4 migraciones |
| Redacción | `technical-writer`, `readme-generator` | 15 documentos con tablas, diagramas y ejemplos verificables |
| Contratos | `api-documenter`, `api-designer` | Envelope uniforme, códigos de error estables, flujos de pago idempotentes |
| IA | `llm-architect` | Cascada, cooldowns, chunking y decay documentados con parámetros reales |
| Legal | `legal-advisor`, `license-engineer` | Licencia propietaria con prohibiciones explícitas y advertencia de consecuencias |
| Control de calidad | `content-quality-editor` | Cero `TODO`, cero marcadores de plantilla, enlaces internos verificados |

> **Nota de alcance:** `legal-advisor` y `license-engineer` producen orientación, no asesoría jurídica vinculante. El texto de `LICENSE.md` debe ser revisado por un abogado habilitado antes de usarse en un litigio.
