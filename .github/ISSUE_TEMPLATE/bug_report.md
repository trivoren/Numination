---
name: Bug report
about: Reporta un comportamiento incorrecto y reproducible en Numination
title: "[BUG] "
labels: ["bug", "needs-triage"]
assignees: []
---

# Reporte de bug

Gracias por tomarte el tiempo de reportar un problema. Completa la mayor cantidad de información posible. Los reportes incompletos tardan más en resolverse.

> ⚠️ **No incluyas secretos, tokens, contraseñas, cadenas de conexión ni datos personales de terceros.**
>
> Si el problema es una vulnerabilidad de seguridad, **no abras este issue**. Sigue [SECURITY.md](../../SECURITY.md) y escribe a security@numination.com.

---

## 1. Descripción del bug

<!-- Una descripción clara y concisa de qué ocurre. -->

**Resumen:**

**¿Desde cuándo ocurre?**

**¿Afecta a todos los usuarios o solo a algunos?**

---

## 2. Pasos para reproducir

<!-- Sé exacto. Incluye URLs, clics, comandos y datos de entrada. -->

1. Ir a `...`
2. Hacer clic en `...`
3. Enviar `...`
4. Observar el error

**Frecuencia:**

- [ ] Siempre (100 %)
- [ ] Frecuentemente (> 50 %)
- [ ] A veces (< 50 %)
- [ ] Solo ocurrió una vez

**¿Ocurre en un entorno limpio?**

- [ ] Sí
- [ ] No
- [ ] No lo probé

---

## 3. Comportamiento esperado

<!-- Qué debería haber pasado según la documentación o el sentido común. -->

```text
Describe el resultado esperado.
```

---

## 4. Comportamiento actual

<!-- Qué pasa realmente. Pega el error completo, no una captura del texto. -->

```text
Pega aquí el error, stack trace o respuesta HTTP.
```

**Código de estado HTTP (si aplica):**

```text
500
```

**Request ID (si aparece en la respuesta o en los logs):**

```text
...
```

---

## 5. Capturas de pantalla o video

<!-- Arrastra aquí imágenes o un video corto. Oculta datos personales, correos y tokens. -->

| Antes | Después |
|---|---|
| <!-- captura --> | <!-- captura --> |

---

## 6. Entorno

Completa todos los campos que apliquen:

| Campo | Valor |
|---|---|
| Sistema operativo | <!-- Windows 11 / macOS 15 / Ubuntu 24.04 --> |
| Versión de Node.js | <!-- node --version --> |
| Navegador y versión | <!-- Chrome 140 / Firefox 141 / Safari 18 --> |
| Versión de Numination | <!-- 3.3.0 --> |
| Commit o release | <!-- v3.3.0 / abc1234 --> |
| Entorno | <!-- local / staging / producción --> |
| Base de datos | <!-- PostgreSQL 15 / Supabase --> |
| Despliegue | <!-- local / Vercel / Node long-running --> |
| Plan de usuario | <!-- free / pro / business --> |

**Comandos ejecutados:**

```bash
node --version
npm --version
npm run migrate:status
```

**Salida de `GET /api/health`:**

```json
{
  "ok": true
}
```

---

## 7. Logs relevantes

<!-- Pega solo las líneas relevantes. Elimina tokens, cookies, emails y datos personales. -->

```text
2026-10-22T10:00:00.000Z ERROR ...
```

**¿Aparece algo en la consola del navegador?**

- [ ] Sí, adjunto abajo
- [ ] No
- [ ] No revisé

```text
Pega aquí los errores de la consola.
```

---

## 8. Contexto adicional

<!-- Configuración especial, extensiones, proxy, VPN, cambios recientes, etc. -->

**¿Funcionaba antes?**

- [ ] Sí, en la versión: `...`
- [ ] No, nunca funcionó
- [ ] No estoy seguro

**¿Hiciste cambios recientes en tu entorno?**

```text
...
```

**¿Probaste desactivar extensiones o usar una ventana incógnito?**

- [ ] Sí
- [ ] No

---

## 9. Checklist del reporte

- [ ] Busqué en los issues existentes y no encontré un duplicado.
- [ ] Leí la documentación relevante en [`docs/`](../../docs/).
- [ ] Reproduje el problema en la última versión disponible.
- [ ] Incluí pasos exactos para reproducir.
- [ ] Incluí el mensaje de error completo.
- [ ] Eliminé secretos, tokens y datos personales del reporte.
- [ ] Indiqué sistema operativo, Node, navegador y versión.
- [ ] Entiendo que este issue es público y que cualquier persona puede leerlo.

---

## 10. Para mantenedores

<!-- No borres esta sección. Ayuda al triaje. -->

**Severidad estimada:**

- [ ] Crítica — pérdida de datos, caída total, problema de seguridad
- [ ] Alta — funcionalidad principal inutilizable
- [ ] Media — funcionalidad secundaria afectada
- [ ] Baja — cosmético o molesto

**Área afectada:**

- [ ] Autenticación
- [ ] Chat / streaming
- [ ] Coder
- [ ] RAG / documentos
- [ ] Memorias
- [ ] Pagos / créditos
- [ ] Personas
- [ ] Webhooks
- [ ] Frontend / UI
- [ ] Base de datos / migraciones
- [ ] Deploy / infraestructura
- [ ] Documentación
- [ ] Otro: `...`

**Notas de triaje:**

```text
Uso interno del equipo de mantenimiento.
```
