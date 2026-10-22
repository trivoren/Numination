/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · admin.js · v1.0
   ───────────────────────────────────────────────────────────────────────────
   Lógica del panel de administración.

   Responsibilities:
     · Consumir /api/admin/{stats,users,payments,logs}
     · Renderizar KPIs, tablas y el gráfico de ingresos
     · Refrescar automáticamente cada 30 segundos (setInterval)
     · Navegación entre vistas (Dashboard / Usuarios / Pagos / Logs)
     · Escapar TODO lo que viene de la API (XSS-safe)

   Dependencias opcionales:
     · window.NumAPI (public/assets/js/api-client.js) → si existe se usa
     · window.Chart (Chart.js CDN)                   → si no carga, se usa un
       renderizador propio con Canvas 2D, para que la gráfica nunca quede
       en blanco ni dependa de la red.
   ═══════════════════════════════════════════════════════════════════════════ */


/* ═══════════════════════════════════════════════════════════════════════════
   ESTILOS DEL PANEL · inyectados desde JS (el proyecto no usa archivos .css)
   ───────────────────────────────────────────────────────────────────────────
   Los tokens de diseño de Numination:
     --c-bg: #0a0a0c   --c-primary: #8b5cf6
   ═══════════════════════════════════════════════════════════════════════════ */

const ADMIN_STYLE_ID = 'numination-admin-styles';

function injectAdminStyles() {
  if (document.getElementById(ADMIN_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = ADMIN_STYLE_ID;
  style.textContent = `
﻿/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · admin.css · v1.0
   ───────────────────────────────────────────────────────────────────────────
   Dashboard de administración. Estilo "dark banking":
     · Fondo profundo #0a0a0c con auroras de color muy sutiles
     · Tarjetas con glassmorphism (blur + borde translúcido)
     · Tablas densas con hoverhighlight y zebra sutil
     · Badges verdes / rojos / ámbar / azul para estados
     · Tipografía: Inter (UI) + JetBrains Mono (números y logs)

   Cargado por: public/admin.html
   ═══════════════════════════════════════════════════════════════════════════ */

:root {
  /* Superficies */
  --bg-0: #0a0a0c;
  --bg-1: #101014;
  --bg-2: #15151b;
  --bg-3: #1c1c24;

  /* Cristal */
  --glass: rgba(255, 255, 255, 0.035);
  --glass-strong: rgba(255, 255, 255, 0.06);
  --border: rgba(255, 255, 255, 0.08);
  --border-strong: rgba(255, 255, 255, 0.14);

  /* Texto */
  --text-0: #f4f4f7;
  --text-1: #c9c9d4;
  --text-2: #8b8b9c;
  --text-3: #5c5c6b;

  /* Acentos */
  --accent: #7c5cff;
  --accent-soft: rgba(124, 92, 255, 0.14);
  --green: #22c55e;
  --green-soft: rgba(34, 197, 94, 0.13);
  --red: #f0433a;
  --red-soft: rgba(240, 67, 58, 0.13);
  --amber: #f5a524;
  --amber-soft: rgba(245, 165, 36, 0.13);
  --cyan: #22d3ee;
  --cyan-soft: rgba(34, 211, 238, 0.13);

  --radius: 14px;
  --radius-sm: 9px;
  --shadow: 0 18px 44px rgba(0, 0, 0, 0.55);
  --shadow-soft: 0 6px 18px rgba(0, 0, 0, 0.35);

  --sidebar-w: 244px;
  --topbar-h: 62px;

  --mono: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  --sans: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}

/* ─── Reset ───────────────────────────────────────────────────────────────── */

*,
*::before,
*::after { box-sizing: border-box; }

html, body { height: 100%; }

body {
  margin: 0;
  font-family: var(--sans);
  font-size: 14px;
  line-height: 1.5;
  color: var(--text-1);
  background: var(--bg-0);
  -webkit-font-smoothing: antialiased;
  overflow-x: hidden;
}

/* Auroras de fondo: dan profundidad sin ensuciar la lectura */
body::before {
  content: '';
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 0;
  background:
    radial-gradient(760px 420px at 12% -8%, rgba(124, 92, 255, 0.16), transparent 62%),
    radial-gradient(680px 380px at 92% 4%, rgba(34, 211, 238, 0.10), transparent 60%),
    radial-gradient(900px 500px at 50% 108%, rgba(245, 165, 36, 0.06), transparent 62%);
}

a { color: inherit; text-decoration: none; }
button { font-family: inherit; }

::selection { background: rgba(124, 92, 255, 0.35); }

/* Scrollbars discretas */
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.09);
  border-radius: 99px;
  border: 3px solid transparent;
  background-clip: content-box;
}
::-webkit-scrollbar-thumb:hover { background: rgba(255, 255, 255, 0.18); background-clip: content-box; }

/* ─── Layout ──────────────────────────────────────────────────────────────── */

.admin-shell {
  position: relative;
  z-index: 1;
  display: grid;
  grid-template-columns: var(--sidebar-w) 1fr;
  min-height: 100vh;
}

/* ─── Sidebar ─────────────────────────────────────────────────────────────── */

.sidebar {
  position: sticky;
  top: 0;
  align-self: start;
  height: 100vh;
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding: 20px 14px;
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.035), rgba(255, 255, 255, 0.012));
  backdrop-filter: blur(18px);
  -webkit-backdrop-filter: blur(18px);
  border-right: 1px solid var(--border);
}

.sidebar__brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 8px 14px;
  border-bottom: 1px solid var(--border);
}

.sidebar__logo {
  width: 34px;
  height: 34px;
  border-radius: 10px;
  display: grid;
  place-items: center;
  font-weight: 800;
  font-size: 15px;
  color: #fff;
  background: linear-gradient(135deg, var(--accent), #4a2fd6);
  box-shadow: 0 6px 18px rgba(124, 92, 255, 0.35);
}

.sidebar__title { font-weight: 700; font-size: 14px; color: var(--text-0); letter-spacing: 0.2px; }
.sidebar__subtitle { font-size: 11px; color: var(--text-3); text-transform: uppercase; letter-spacing: 0.9px; }

.sidebar__nav { display: flex; flex-direction: column; gap: 4px; flex: 1; }

.nav-item {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  color: var(--text-2);
  font-weight: 500;
  font-size: 13.5px;
  cursor: pointer;
  border: 1px solid transparent;
  transition: background 0.16s ease, color 0.16s ease, border-color 0.16s ease, transform 0.16s ease;
  background: transparent;
  width: 100%;
  text-align: left;
}

.nav-item:hover { background: var(--glass); color: var(--text-0); }
.nav-item:active { transform: scale(0.985); }
.nav-item:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

.nav-item.is-active {
  background: var(--accent-soft);
  border-color: rgba(124, 92, 255, 0.32);
  color: var(--text-0);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06);
}

.nav-item__icon { width: 17px; height: 17px; flex: 0 0 17px; opacity: 0.9; }
.nav-item__label { flex: 1; }

.nav-item__badge {
  min-width: 20px;
  padding: 1px 6px;
  border-radius: 99px;
  font-family: var(--mono);
  font-size: 10.5px;
  font-weight: 600;
  text-align: center;
  background: var(--glass-strong);
  color: var(--text-1);
}

.sidebar__footer {
  padding-top: 14px;
  border-top: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.sidebar__user {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px;
  border-radius: var(--radius-sm);
  background: var(--glass);
}

.avatar {
  width: 32px; height: 32px;
  border-radius: 50%;
  display: grid; place-items: center;
  font-weight: 700; font-size: 13px;
  color: #fff;
  background: linear-gradient(135deg, #3f3f56, #26263a);
  flex: 0 0 32px;
}

.sidebar__user-name { font-size: 12.5px; font-weight: 600; color: var(--text-0); }
.sidebar__user-mail { font-size: 11px; color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 140px; }

/* ─── Main ────────────────────────────────────────────────────────────────── */

.main { display: flex; flex-direction: column; min-width: 0; }

.topbar {
  position: sticky;
  top: 0;
  z-index: 20;
  height: var(--topbar-h);
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 0 26px;
  background: rgba(10, 10, 12, 0.72);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  border-bottom: 1px solid var(--border);
}

.topbar__title { font-size: 16px; font-weight: 700; color: var(--text-0); }
.topbar__spacer { flex: 1; }

.topbar__status {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text-2);
  padding: 5px 10px;
  border-radius: 99px;
  background: var(--glass);
  border: 1px solid var(--border);
}

.pulse {
  width: 7px; height: 7px;
  border-radius: 50%;
  background: var(--green);
  box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.55);
  animation: pulse 2.1s infinite;
}
.pulse.is-stale { background: var(--amber); }
.pulse.is-error { background: var(--red); }

@keyframes pulse {
  0%   { box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.5); }
  70%  { box-shadow: 0 0 0 8px rgba(34, 197, 94, 0); }
  100% { box-shadow: 0 0 0 0 rgba(34, 197, 94, 0); }
}

.btn {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 8px 14px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-strong);
  background: var(--glass);
  color: var(--text-1);
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s ease, transform 0.15s ease, border-color 0.15s ease, color 0.15s ease;
}
.btn:hover { background: var(--glass-strong); color: var(--text-0); border-color: rgba(255, 255, 255, 0.22); }
.btn:active { transform: scale(0.97); }
.btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.btn[disabled] { opacity: 0.45; cursor: not-allowed; transform: none; }

.btn--primary {
  background: linear-gradient(135deg, var(--accent), #5b3ef0);
  border-color: transparent;
  color: #fff;
  box-shadow: 0 6px 18px rgba(124, 92, 255, 0.28);
}
.btn--primary:hover { background: linear-gradient(135deg, #8b6dff, #6446ff); color: #fff; }
.btn--danger { color: #ff8b84; border-color: rgba(240, 67, 58, 0.35); background: var(--red-soft); }
.btn--danger:hover { background: rgba(240, 67, 58, 0.22); color: #ffb0ab; }
.btn--ghost { background: transparent; border-color: transparent; }
.btn--sm { padding: 5px 10px; font-size: 11.5px; }

/* ─── Contenido ───────────────────────────────────────────────────────────── */

.content { padding: 24px 26px 56px; display: flex; flex-direction: column; gap: 20px; }

.section { display: flex; flex-direction: column; gap: 16px; }
.section[hidden] { display: none; }

.section__head {
  display: flex;
  align-items: baseline;
  gap: 12px;
  flex-wrap: wrap;
}
.section__title { font-size: 15px; font-weight: 700; color: var(--text-0); margin: 0; }
.section__hint { font-size: 12px; color: var(--text-3); }

/* ─── Tarjetas KPI ────────────────────────────────────────────────────────── */

.kpi-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 16px;
}

.kpi {
  position: relative;
  overflow: hidden;
  padding: 18px 18px 16px;
  border-radius: var(--radius);
  background: linear-gradient(145deg, rgba(255, 255, 255, 0.055), rgba(255, 255, 255, 0.018));
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-soft);
  transition: transform 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease;
}

.kpi:hover {
  transform: translateY(-2px);
  border-color: var(--border-strong);
  box-shadow: var(--shadow);
}

.kpi::after {
  content: '';
  position: absolute;
  inset: auto -30% -60% auto;
  width: 180px; height: 180px;
  border-radius: 50%;
  background: radial-gradient(circle, var(--kpi-glow, rgba(124, 92, 255, 0.22)), transparent 68%);
  pointer-events: none;
}

.kpi--green { --kpi-glow: rgba(34, 197, 94, 0.24); }
.kpi--red   { --kpi-glow: rgba(240, 67, 58, 0.22); }
.kpi--cyan  { --kpi-glow: rgba(34, 211, 238, 0.22); }
.kpi--amber { --kpi-glow: rgba(245, 165, 36, 0.22); }

.kpi__label {
  display: flex; align-items: center; gap: 7px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.85px;
  text-transform: uppercase;
  color: var(--text-3);
}

.kpi__value {
  margin: 10px 0 6px;
  font-family: var(--mono);
  font-size: 27px;
  font-weight: 700;
  letter-spacing: -0.7px;
  color: var(--text-0);
  line-height: 1.1;
}

.kpi__delta { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 600; }
.kpi__delta--up { color: var(--green); }
.kpi__delta--down { color: var(--red); }
.kpi__delta--flat { color: var(--text-3); }
.kpi__foot { font-size: 11px; color: var(--text-3); margin-top: 4px; }

/* ─── Paneles ─────────────────────────────────────────────────────────────── */

.panel {
  border-radius: var(--radius);
  background: linear-gradient(145deg, rgba(255, 255, 255, 0.045), rgba(255, 255, 255, 0.015));
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-soft);
  overflow: hidden;
}

.panel__head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 15px 18px;
  border-bottom: 1px solid var(--border);
}
.panel__title { font-size: 13.5px; font-weight: 700; color: var(--text-0); margin: 0; }
.panel__sub { font-size: 11.5px; color: var(--text-3); }
.panel__actions { margin-left: auto; display: flex; gap: 8px; align-items: center; }
.panel__body { padding: 18px; }
.panel__body--flush { padding: 0; }

.grid-2 { display: grid; grid-template-columns: minmax(0, 1.55fr) minmax(0, 1fr); gap: 16px; }

/* ─── Chart ───────────────────────────────────────────────────────────────── */

.chart-wrap { position: relative; width: 100%; height: 300px; }
.chart-wrap canvas { width: 100% !important; height: 100% !important; }

.chart-legend { display: flex; gap: 16px; flex-wrap: wrap; margin-top: 14px; }
.chart-legend__item { display: inline-flex; align-items: center; gap: 7px; font-size: 12px; color: var(--text-2); }
.chart-legend__dot { width: 9px; height: 9px; border-radius: 3px; }

/* ─── Tablas ──────────────────────────────────────────────────────────────── */

.table-scroll { width: 100%; overflow-x: auto; }

.table { width: 100%; border-collapse: collapse; font-size: 12.5px; }

.table thead th {
  position: sticky;
  top: 0;
  z-index: 1;
  text-align: left;
  padding: 11px 16px;
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.9px;
  text-transform: uppercase;
  color: var(--text-3);
  background: rgba(16, 16, 20, 0.92);
  backdrop-filter: blur(8px);
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
}

.table tbody td {
  padding: 11px 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.045);
  color: var(--text-1);
  vertical-align: middle;
}

.table tbody tr { transition: background 0.13s ease; }
.table tbody tr:hover { background: rgba(255, 255, 255, 0.035); }
.table tbody tr:last-child td { border-bottom: none; }

.table .num { font-family: var(--mono); text-align: right; white-space: nowrap; }
.table .mono { font-family: var(--mono); font-size: 11.5px; }
.table .muted { color: var(--text-3); }
.table .nowrap { white-space: nowrap; }

.cell-user { display: flex; align-items: center; gap: 10px; }
.cell-user__name { color: var(--text-0); font-weight: 600; }
.cell-user__mail { font-size: 11px; color: var(--text-3); }

/* ─── Badges ──────────────────────────────────────────────────────────────── */

.badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 9px;
  border-radius: 99px;
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.45px;
  text-transform: uppercase;
  white-space: nowrap;
  border: 1px solid transparent;
}

.badge--green { background: var(--green-soft); color: #4ade80; border-color: rgba(34, 197, 94, 0.28); }
.badge--red   { background: var(--red-soft);   color: #ff7a72; border-color: rgba(240, 67, 58, 0.28); }
.badge--amber { background: var(--amber-soft); color: #fbbf24; border-color: rgba(245, 165, 36, 0.28); }
.badge--cyan  { background: var(--cyan-soft);  color: #38d6f0; border-color: rgba(34, 211, 238, 0.26); }
.badge--muted { background: var(--glass); color: var(--text-2); border-color: var(--border); }

.badge__dot { width: 5px; height: 5px; border-radius: 50%; background: currentColor; }

/* ─── Toolbar / filtros ───────────────────────────────────────────────────── */

.toolbar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }

.input, .select {
  padding: 8px 12px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-strong);
  background: rgba(255, 255, 255, 0.03);
  color: var(--text-0);
  font-family: inherit;
  font-size: 12.5px;
  min-width: 180px;
  transition: border-color 0.15s ease, background 0.15s ease;
}
.input::placeholder { color: var(--text-3); }
.input:focus, .select:focus {
  outline: none;
  border-color: var(--accent);
  background: rgba(124, 92, 255, 0.07);
}
.select option { background: var(--bg-2); color: var(--text-0); }

/* ─── Paginación ──────────────────────────────────────────────────────────── */

.pagination {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 18px;
  border-top: 1px solid var(--border);
  font-size: 12px;
  color: var(--text-3);
}
.pagination__spacer { flex: 1; }

/* ─── Estados vacíos / carga ──────────────────────────────────────────────── */

.empty {
  padding: 46px 20px;
  text-align: center;
  color: var(--text-3);
  font-size: 13px;
}
.empty__icon { font-size: 26px; opacity: 0.5; display: block; margin-bottom: 8px; }

.skeleton {
  position: relative;
  overflow: hidden;
  background: rgba(255, 255, 255, 0.045);
  border-radius: 6px;
}
.skeleton::after {
  content: '';
  position: absolute;
  inset: 0;
  transform: translateX(-100%);
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.07), transparent);
  animation: shimmer 1.35s infinite;
}
@keyframes shimmer { 100% { transform: translateX(100%); } }

.skeleton-row { height: 14px; margin: 12px 16px; }

/* ─── Toasts ──────────────────────────────────────────────────────────────── */

.toasts {
  position: fixed;
  right: 20px;
  bottom: 20px;
  z-index: 90;
  display: flex;
  flex-direction: column;
  gap: 9px;
  pointer-events: none;
}

.toast {
  pointer-events: auto;
  min-width: 240px;
  max-width: 380px;
  padding: 11px 14px;
  border-radius: var(--radius-sm);
  background: rgba(21, 21, 27, 0.95);
  border: 1px solid var(--border-strong);
  box-shadow: var(--shadow);
  color: var(--text-1);
  font-size: 12.5px;
  animation: toast-in 0.22s ease;
}
.toast--ok { border-left: 3px solid var(--green); }
.toast--err { border-left: 3px solid var(--red); }
.toast--info { border-left: 3px solid var(--cyan); }

@keyframes toast-in {
  from { opacity: 0; transform: translateY(10px) scale(0.97); }
  to   { opacity: 1; transform: none; }
}

/* ─── Responsive ──────────────────────────────────────────────────────────── */

@media (max-width: 1180px) {
  .kpi-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .grid-2 { grid-template-columns: 1fr; }
}

@media (max-width: 860px) {
  .admin-shell { grid-template-columns: 1fr; }
  .sidebar {
    position: fixed;
    z-index: 60;
    width: var(--sidebar-w);
    transform: translateX(-100%);
    transition: transform 0.22s ease;
    background: rgba(13, 13, 17, 0.97);
  }
  .sidebar.is-open { transform: none; }
  .content { padding: 18px 16px 48px; }
  .topbar { padding: 0 16px; }
}

@media (max-width: 520px) {
  .kpi-grid { grid-template-columns: 1fr; }
  .kpi__value { font-size: 23px; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.001ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.001ms !important;
  }
}

`;
  document.head.appendChild(style);
}

/* ─── Configuración ───────────────────────────────────────────────────────── */

const REFRESH_MS = 30_000;
const PAGE_SIZE = 20;

const STATE = {
  view: 'dashboard',
  stats: null,
  chart: null,
  chartRenderer: null,
  users: { page: 0, pages: 1, total: 0, q: '', role: '', plan: '' },
  payments: { page: 0, pages: 1, total: 0, status: '' },
  logs: { page: 0, pages: 1, total: 0, level: '' },
  timer: null,
  loading: false,
  booted: false,
};

/* ─── Helpers ─────────────────────────────────────────────────────────────── */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

/**
 * Escapa HTML. Todo valor que venga del servidor pasa por acá antes de
 * tocar el DOM: el panel es una superficie de admin, pero un XSS en un
 * nombre de usuario compromete toda la consola.
 */
function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtNumber(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '0';
  return new Intl.NumberFormat('es-CO').format(v);
}

function fmtCurrency(n, currency = 'USD') {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  try {
    return new Intl.NumberFormat('es-CO', {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    }).format(v);
  } catch {
    return `${currency} ${v.toFixed(2)}`;
  }
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('es-CO', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(d);
}

function fmtRelative(iso) {
  if (!iso) return '—';
  const d = new Date(iso).getTime();
  if (Number.isNaN(d)) return '—';
  const diff = Date.now() - d;
  const min = Math.round(diff / 60000);
  if (min < 1) return 'ahora';
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `hace ${h} h`;
  const d2 = Math.round(h / 24);
  if (d2 < 30) return `hace ${d2} d`;
  return fmtDate(iso);
}

function fmtPct(n, decimals = 1) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '0%';
  return `${v.toFixed(decimals)}%`;
}

function initials(text) {
  const s = String(text || '?').trim();
  const parts = s.split(/[\s@._-]+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
}

function toast(message, kind = 'info') {
  const host = $('#toasts');
  if (!host) return;
  const el = document.createElement('div');
  el.className = `toast toast--${kind === 'error' ? 'err' : kind === 'ok' ? 'ok' : 'info'}`;
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(8px)';
    el.style.transition = 'opacity .2s ease, transform .2s ease';
    setTimeout(() => el.remove(), 220);
  }, 3800);
}

/* ─── Cliente HTTP ────────────────────────────────────────────────────────── */

async function api(path, options = {}) {
  const { method = 'GET', body, timeoutMs = 20000 } = options;

  if (window.NumAPI && typeof window.NumAPI.request === 'function') {
    return window.NumAPI.request(path, { method, body, timeoutMs });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const init = {
      method,
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    };
    if (body !== undefined && body !== null) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await fetch(path, init);
    const text = await res.text();
    let payload = null;
    if (text) {
      try { payload = JSON.parse(text); } catch { payload = { raw: text }; }
    }
    if (!res.ok) {
      const message = payload?.error || `Error ${res.status}`;
      throw new Error(message);
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

/* ─── Render: KPIs ────────────────────────────────────────────────────────── */

function setDelta(el, value, suffix = '') {
  if (!el) return;
  const v = Number(value);
  if (!Number.isFinite(v)) {
    el.className = 'kpi__delta kpi__delta--flat';
    el.textContent = '—';
    return;
  }
  const up = v > 0;
  const flat = v === 0;
  el.className = `kpi__delta kpi__delta--${flat ? 'flat' : up ? 'up' : 'down'}`;
  el.textContent = `${flat ? '±0' : up ? '▲' : '▼'} ${Math.abs(v).toFixed(1)}${suffix}`;
}

function renderStats(stats) {
  if (!stats) return;

  const revenue = Number(stats.totalRevenue ?? 0);
  const revenueDelta = Number(stats.revenueDeltaPct ?? 0);
  $('#kpi-revenue').textContent = fmtCurrency(revenue, stats.currency || 'USD');
  setDelta($('#kpi-revenue-delta'), revenueDelta, '%');
  $('#kpi-revenue-foot').textContent = `${fmtNumber(stats.completedPayments ?? 0)} pagos completados`;

  const users = Number(stats.totalUsers ?? 0);
  $('#kpi-users').textContent = fmtNumber(users);
  setDelta($('#kpi-users-delta'), Number(stats.usersDeltaPct ?? 0), '%');
  $('#kpi-users-foot').textContent = `${fmtNumber(stats.newUsers30d ?? 0)} nuevos en 30 días`;

  const ticket = Number(stats.avgTicket ?? 0);
  $('#kpi-ticket').textContent = fmtCurrency(ticket, stats.currency || 'USD');
  setDelta($('#kpi-ticket-delta'), Number(stats.ticketDeltaPct ?? 0), '%');
  $('#kpi-ticket-foot').textContent = `${fmtNumber(stats.completedPayments ?? 0)} transacciones`;

  const failure = Number(stats.failureRatePct ?? 0);
  $('#kpi-failure').textContent = fmtPct(failure);
  const fEl = $('#kpi-failure-delta');
  if (fEl) {
    fEl.className = `kpi__delta kpi__delta--${failure > 5 ? 'down' : 'flat'}`;
    fEl.textContent = failure > 5 ? '▲ requiere atención' : '▲ dentro de rango';
  }
  $('#kpi-failure-foot').textContent = `${fmtNumber(stats.failedPayments ?? 0)} pagos rechazados`;

  const badgeUsers = $('#badge-users');
  if (badgeUsers) badgeUsers.textContent = fmtNumber(users);
  const badgePay = $('#badge-payments');
  if (badgePay) badgePay.textContent = fmtNumber(stats.completedPayments ?? 0);

  const updated = $('#stats-updated');
  if (updated) {
    updated.textContent = `Actualizado: ${new Date().toLocaleTimeString('es-CO')}`;
  }

  const pulse = $('#db-pulse');
  const dbStatus = $('#db-status');
  if (pulse && dbStatus) {
    if (stats.degraded) {
      pulse.className = 'pulse is-stale';
      dbStatus.textContent = 'modo simulado';
    } else {
      pulse.className = 'pulse';
      dbStatus.textContent = 'en vivo';
    }
  }

  renderHealth(stats.health);
  renderRevenueChart(Array.isArray(stats.revenueByDay) ? stats.revenueByDay : []);
  renderRecentUsers(Array.isArray(stats.recentUsers) ? stats.recentUsers : []);
}

function renderHealth(health) {
  const host = $('#health-list');
  if (!host) return;
  const items = Array.isArray(health) ? health : [];

  if (!items.length) {
    host.innerHTML = '<div class="empty"><span class="empty__icon">◔</span>Sin datos de salud.</div>';
    return;
  }

  host.innerHTML = items.map((h) => {
    const status = String(h.status || 'ok');
    const badgeClass = status === 'ok' ? 'green' : status === 'warn' ? 'amber' : 'red';
    const label = status === 'ok' ? 'Operativo' : status === 'warn' ? 'Degradado' : 'Caído';
    return `
      <div style="display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid rgba(255,255,255,.05)">
        <span class="badge badge--${badgeClass}"><span class="badge__dot"></span>${esc(label)}</span>
        <span style="flex:1;color:var(--text-1);font-size:12.5px">${esc(h.name || h.component || '—')}</span>
        <span class="mono" style="color:var(--text-3);font-size:11.5px">${esc(h.detail || h.value || '')}</span>
      </div>`;
  }).join('');
}

function renderRecentUsers(users) {
  const tbody = $('#recent-users-table tbody');
  if (!tbody) return;

  if (!users.length) {
    tbody.innerHTML = '<tr><td colspan="4"><div class="empty"><span class="empty__icon">◔</span>Sin usuarios todavía.</div></td></tr>';
    return;
  }

  tbody.innerHTML = users.slice(0, 8).map((u) => `
    <tr>
      <td>
        <div class="cell-user">
          <div class="avatar">${esc(initials(u.name || u.email))}</div>
          <div>
            <div class="cell-user__name">${esc(u.name || 'Sin nombre')}</div>
            <div class="cell-user__mail">${esc(u.email || '—')}</div>
          </div>
        </div>
      </td>
      <td><span class="badge badge--muted">${esc(u.plan || u.tier || 'free')}</span></td>
      <td class="muted nowrap">${esc(fmtRelative(u.created_at || u.createdAt))}</td>
      <td class="num">${esc(fmtNumber(u.messages ?? 0))}</td>
    </tr>`).join('');
}

/* ─── Render: Gráfica ─────────────────────────────────────────────────────── */

const CHART_COLORS = {
  line: 'rgba(124, 92, 255, 1)',
  fill: 'rgba(124, 92, 255, 0.16)',
  grid: 'rgba(255, 255, 255, 0.055)',
  text: 'rgba(139, 139, 156, 1)',
};

function waitForChart(timeoutMs = 4000) {
  return new Promise((resolve) => {
    if (window.Chart) return resolve(window.Chart);
    const started = Date.now();
    const tick = () => {
      if (window.Chart) return resolve(window.Chart);
      if (Date.now() - started > timeoutMs) return resolve(null);
      setTimeout(tick, 120);
    };
    tick();
  });
}

/**
 * Renderizador de respaldo con Canvas 2D.
 * Si Chart.js no está disponible (CDN bloqueado por CSP o sin red), la
 * gráfica se dibuja a mano para que el dashboard nunca se vea vacío.
 */
function drawFallbackChart(canvas, series) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(rect.width, 320);
  const h = Math.max(rect.height, 220);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const values = series.map((d) => Number(d.amount ?? d.value ?? 0));
  const max = Math.max(...values, 1);
  const padL = 52;
  const padR = 12;
  const padT = 16;
  const padB = 26;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  // Grid horizontal
  ctx.strokeStyle = CHART_COLORS.grid;
  ctx.lineWidth = 1;
  ctx.fillStyle = CHART_COLORS.text;
  ctx.font = '11px JetBrains Mono, monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= 4; i++) {
    const y = padT + (plotH / 4) * i;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(w - padR, y);
    ctx.stroke();
    ctx.fillText(String(Math.round(max - (max / 4) * i)), padL - 8, y);
  }

  if (!values.length) {
    ctx.textAlign = 'center';
    ctx.fillText('Sin datos en el período', w / 2, h / 2);
    return;
  }

  const step = plotW / Math.max(values.length - 1, 1);
  const points = values.map((v, i) => ({
    x: padL + step * i,
    y: padT + plotH - (v / max) * plotH,
  }));

  // Área
  const grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
  grad.addColorStop(0, 'rgba(124, 92, 255, 0.34)');
  grad.addColorStop(1, 'rgba(124, 92, 255, 0.01)');
  ctx.beginPath();
  ctx.moveTo(points[0].x, padT + plotH);
  points.forEach((p) => ctx.lineTo(p.x, p.y));
  ctx.lineTo(points[points.length - 1].x, padT + plotH);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // Línea
  ctx.beginPath();
  points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  ctx.strokeStyle = CHART_COLORS.line;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.stroke();

  // Puntos + tooltip estático (último valor)
  ctx.fillStyle = CHART_COLORS.line;
  points.forEach((p) => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 2.4, 0, Math.PI * 2);
    ctx.fill();
  });

  // Eje X (primer, medio y último)
  ctx.fillStyle = CHART_COLORS.text;
  ctx.font = '10.5px JetBrains Mono, monospace';
  ctx.textBaseline = 'top';
  const idxs = [0, Math.floor(series.length / 2), series.length - 1].filter((v, i, a) => a.indexOf(v) === i);
  idxs.forEach((i) => {
    const label = String(series[i].date || series[i].day || '').slice(5);
    ctx.textAlign = i === 0 ? 'left' : i === series.length - 1 ? 'right' : 'center';
    ctx.fillText(label, points[i].x, padT + plotH + 8);
  });
}

async function renderRevenueChart(series) {
  const canvas = $('#revenue-chart');
  if (!canvas) return;

  const labels = series.map((d) => String(d.date || d.day || '').slice(5));
  const values = series.map((d) => Number(d.amount ?? d.value ?? 0));
  const total = values.reduce((a, b) => a + b, 0);

  const totalBadge = $('#chart-total');
  if (totalBadge) totalBadge.textContent = fmtCurrency(total, 'USD');

  const legend = $('#chart-legend');
  if (legend) {
    legend.innerHTML = `
      <span class="chart-legend__item">
        <span class="chart-legend__dot" style="background:${CHART_COLORS.line}"></span> Ingresos diarios
      </span>
      <span class="chart-legend__item">
        <span class="chart-legend__dot" style="background:rgba(34,211,238,.9)"></span> Total ${esc(fmtCurrency(total, 'USD'))}
      </span>`;
  }

  const Chart = await waitForChart();

  if (!Chart) {
    // Respaldo propio
    drawFallbackChart(canvas, series);
    STATE.chartRenderer = 'canvas-fallback';
    return;
  }

  if (STATE.chart && STATE.chartRenderer === 'chartjs') {
    STATE.chart.data.labels = labels;
    STATE.chart.data.datasets[0].data = values;
    STATE.chart.update('none');
    return;
  }

  const ctx = canvas.getContext('2d');
  const gradient = ctx.createLinearGradient(0, 0, 0, 300);
  gradient.addColorStop(0, 'rgba(124, 92, 255, 0.36)');
  gradient.addColorStop(1, 'rgba(124, 92, 255, 0.02)');

  STATE.chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Ingresos',
          data: values,
          borderColor: CHART_COLORS.line,
          backgroundColor: gradient,
          borderWidth: 2,
          fill: true,
          tension: 0.34,
          pointRadius: 0,
          pointHoverRadius: 4,
          pointHoverBackgroundColor: '#fff',
          pointHoverBorderColor: CHART_COLORS.line,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(21,21,27,.96)',
          borderColor: 'rgba(255,255,255,.14)',
          borderWidth: 1,
          titleColor: '#f4f4f7',
          bodyColor: '#c9c9d4',
          padding: 10,
          displayColors: false,
          callbacks: {
            label: (item) => fmtCurrency(item.parsed.y, 'USD'),
          },
        },
      },
      scales: {
        x: {
          grid: { color: CHART_COLORS.grid, drawTicks: false },
          border: { display: false },
          ticks: { color: CHART_COLORS.text, maxTicksLimit: 8, font: { family: 'JetBrains Mono', size: 10 } },
        },
        y: {
          beginAtZero: true,
          grid: { color: CHART_COLORS.grid, drawTicks: false },
          border: { display: false },
          ticks: {
            color: CHART_COLORS.text,
            font: { family: 'JetBrains Mono', size: 10 },
            callback: (v) => `$${Number(v).toFixed(0)}`,
          },
        },
      },
    },
  });
  STATE.chartRenderer = 'chartjs';
}

/* ─── Render: Usuarios ────────────────────────────────────────────────────── */

function statusBadge(user) {
  if (user.banned) return '<span class="badge badge--red"><span class="badge__dot"></span>Baneado</span>';
  if (user.suspended) return '<span class="badge badge--amber"><span class="badge__dot"></span>Suspendido</span>';
  if (user.verified === false) return '<span class="badge badge--amber">Sin verificar</span>';
  return '<span class="badge badge--green"><span class="badge__dot"></span>Activo</span>';
}

function roleBadge(role) {
  const cls = role === 'admin' ? 'cyan' : role === 'teacher' ? 'muted' : 'muted';
  return `<span class="badge badge--${cls}">${esc(role || 'student')}</span>`;
}

async function loadUsers() {
  const tbody = $('#users-table tbody');
  if (!tbody) return;

  const params = new URLSearchParams({
    page: String(STATE.users.page + 1),
    limit: String(PAGE_SIZE),
  });
  if (STATE.users.q) params.set('q', STATE.users.q);
  if (STATE.users.role) params.set('role', STATE.users.role);
  if (STATE.users.plan) params.set('plan', STATE.users.plan);

  tbody.innerHTML = `<tr><td colspan="7"><div class="empty"><span class="empty__icon">◔</span>Cargando…</div></td></tr>`;

  try {
    const data = await api(`/api/admin/users?${params.toString()}`);
    const users = Array.isArray(data?.users) ? data.users : [];
    STATE.users.total = Number(data?.total ?? users.length);
    STATE.users.pages = Math.max(Number(data?.pages ?? 1), 1);

    if (!users.length) {
      tbody.innerHTML = '<tr><td colspan="7"><div class="empty"><span class="empty__icon">◔</span>Ningún usuario coincide con el filtro.</div></td></tr>';
    } else {
      tbody.innerHTML = users.map((u) => `
        <tr data-user-id="${esc(u.id)}">
          <td>
            <div class="cell-user">
              <div class="avatar">${esc(initials(u.name || u.email))}</div>
              <div>
                <div class="cell-user__name">${esc(u.name || 'Sin nombre')}</div>
                <div class="cell-user__mail">${esc(u.email || '—')}</div>
              </div>
            </div>
          </td>
          <td>${roleBadge(u.role)}</td>
          <td><span class="badge badge--muted">${esc(u.plan || u.tier || 'free')}</span></td>
          <td>${statusBadge(u)}</td>
          <td class="muted nowrap">${esc(fmtRelative(u.last_login_at || u.lastLoginAt))}</td>
          <td class="num">${esc(fmtNumber(u.messages ?? 0))}</td>
          <td style="text-align:right">
            <button class="btn btn--sm" data-action="toggle-ban" data-id="${esc(u.id)}" type="button">
              ${u.banned ? 'Desbanear' : 'Banear'}
            </button>
          </td>
        </tr>`).join('');
    }

    const range = $('#users-range');
    if (range) {
      const from = STATE.users.total === 0 ? 0 : STATE.users.page * PAGE_SIZE + 1;
      const to = Math.min((STATE.users.page + 1) * PAGE_SIZE, STATE.users.total);
      range.textContent = `Mostrando ${from}–${to} de ${fmtNumber(STATE.users.total)}`;
    }
    $('#users-prev').disabled = STATE.users.page <= 0;
    $('#users-next').disabled = STATE.users.page + 1 >= STATE.users.pages;
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty"><span class="empty__icon">⚠</span>${esc(err.message)}</div></td></tr>`;
  }
}

/* ─── Render: Pagos ───────────────────────────────────────────────────────── */

function paymentBadge(status) {
  const s = String(status || '').toLowerCase();
  const map = {
    completed: 'green',
    created: 'muted',
    pending: 'amber',
    failed: 'red',
    refunded: 'cyan',
  };
  return `<span class="badge badge--${map[s] || 'muted'}"><span class="badge__dot"></span>${esc(s || 'desconocido')}</span>`;
}

async function loadPayments() {
  const tbody = $('#payments-table tbody');
  if (!tbody) return;

  const params = new URLSearchParams({
    page: String(STATE.payments.page + 1),
    limit: String(PAGE_SIZE),
  });
  if (STATE.payments.status) params.set('status', STATE.payments.status);

  tbody.innerHTML = `<tr><td colspan="7"><div class="empty"><span class="empty__icon">◔</span>Cargando…</div></td></tr>`;

  try {
    const data = await api(`/api/admin/payments?${params.toString()}`);
    const rows = Array.isArray(data?.payments) ? data.payments : [];
    STATE.payments.total = Number(data?.total ?? rows.length);
    STATE.payments.pages = Math.max(Number(data?.pages ?? 1), 1);

    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="7"><div class="empty"><span class="empty__icon">◔</span>Sin pagos registrados.</div></td></tr>';
    } else {
      tbody.innerHTML = rows.map((p) => `
        <tr>
          <td class="mono">${esc(String(p.paypal_order_id || p.id || '').slice(0, 18))}</td>
          <td><span class="badge badge--muted">${esc(p.plan_id || '—')}</span></td>
          <td>${paymentBadge(p.status)}</td>
          <td class="num">${esc(fmtCurrency(p.amount_usd ?? p.amount_cop ?? 0, p.currency || 'USD'))}</td>
          <td class="num">${esc(fmtNumber(p.credits_granted ?? 0))}</td>
          <td class="muted nowrap">${esc(fmtDate(p.created_at))}</td>
          <td style="text-align:right">
            <a class="btn btn--sm" href="/api/billing/invoices/${esc(p.id)}/pdf" target="_blank" rel="noopener">PDF</a>
          </td>
        </tr>`).join('');
    }

    const range = $('#payments-range');
    if (range) {
      const from = STATE.payments.total === 0 ? 0 : STATE.payments.page * PAGE_SIZE + 1;
      const to = Math.min((STATE.payments.page + 1) * PAGE_SIZE, STATE.payments.total);
      range.textContent = `Mostrando ${from}–${to} de ${fmtNumber(STATE.payments.total)}`;
    }
    $('#payments-prev').disabled = STATE.payments.page <= 0;
    $('#payments-next').disabled = STATE.payments.page + 1 >= STATE.payments.pages;
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty"><span class="empty__icon">⚠</span>${esc(err.message)}</div></td></tr>`;
  }
}

/* ─── Render: Logs ────────────────────────────────────────────────────────── */

function logBadge(level) {
  const l = String(level || 'info').toLowerCase();
  const map = { error: 'red', warn: 'amber', info: 'cyan', debug: 'muted' };
  return `<span class="badge badge--${map[l] || 'muted'}">${esc(l)}</span>`;
}

async function loadLogs() {
  const tbody = $('#logs-table tbody');
  if (!tbody) return;

  const params = new URLSearchParams({
    page: String(STATE.logs.page + 1),
    limit: String(PAGE_SIZE),
  });
  if (STATE.logs.level) params.set('level', STATE.logs.level);

  tbody.innerHTML = `<tr><td colspan="4"><div class="empty"><span class="empty__icon">◔</span>Cargando…</div></td></tr>`;

  try {
    const data = await api(`/api/admin/logs?${params.toString()}`);
    const rows = Array.isArray(data?.logs) ? data.logs : [];
    STATE.logs.total = Number(data?.total ?? rows.length);
    STATE.logs.pages = Math.max(Number(data?.pages ?? 1), 1);

    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="4"><div class="empty"><span class="empty__icon">◔</span>Sin registros de auditoría.</div></td></tr>';
    } else {
      tbody.innerHTML = rows.map((l) => `
        <tr>
          <td class="muted nowrap">${esc(fmtDate(l.created_at || l.ts))}</td>
          <td>${logBadge(l.level)}</td>
          <td class="mono">${esc(l.event || l.action || '—')}</td>
          <td class="muted">${esc(l.detail || l.message || '')}</td>
        </tr>`).join('');
    }

    const range = $('#logs-range');
    if (range) {
      const from = STATE.logs.total === 0 ? 0 : STATE.logs.page * PAGE_SIZE + 1;
      const to = Math.min((STATE.logs.page + 1) * PAGE_SIZE, STATE.logs.total);
      range.textContent = `Mostrando ${from}–${to} de ${fmtNumber(STATE.logs.total)}`;
    }
    $('#logs-prev').disabled = STATE.logs.page <= 0;
    $('#logs-next').disabled = STATE.logs.page + 1 >= STATE.logs.pages;
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="4"><div class="empty"><span class="empty__icon">⚠</span>${esc(err.message)}</div></td></tr>`;
  }
}

/* ─── Carga de datos ──────────────────────────────────────────────────────── */

async function loadStats() {
  try {
    const data = await api('/api/admin/stats');
    if (!data || data.ok === false) throw new Error(data?.error || 'Respuesta inválida');
    STATE.stats = data;
    renderStats(data);
  } catch (err) {
    toast(`No se pudieron cargar las métricas: ${err.message}`, 'error');
    const pulse = $('#db-pulse');
    if (pulse) pulse.className = 'pulse is-error';
  }
}

async function loadActiveView() {
  if (STATE.loading) return;
  STATE.loading = true;
  try {
    switch (STATE.view) {
      case 'usuarios': await loadUsers(); break;
      case 'pagos': await loadPayments(); break;
      case 'logs': await loadLogs(); break;
      default: await loadStats(); break;
    }
  } finally {
    STATE.loading = false;
  }
}

async function refreshAll() {
  await Promise.allSettled([loadStats(), loadActiveView()]);
}

/* ─── Navegación ──────────────────────────────────────────────────────────── */

const VIEW_TITLES = {
  dashboard: 'Dashboard',
  usuarios: 'Usuarios',
  pagos: 'Pagos',
  logs: 'Logs',
};

function setView(view) {
  STATE.view = view;

  $$('.nav-item').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.view === view);
  });

  $$('.section').forEach((sec) => {
    const match = sec.id === `view-${view}`;
    sec.hidden = !match;
  });

  const title = $('#topbar-title');
  if (title) title.textContent = VIEW_TITLES[view] || 'Panel';

  const sidebar = $('#sidebar');
  if (sidebar) sidebar.classList.remove('is-open');

  loadActiveView();
}

/* ─── Sesión ──────────────────────────────────────────────────────────────── */

async function loadSession() {
  try {
    const data = await api('/api/auth/me', { silent: true });
    const user = data?.user || data;
    if (!user || !user.id) return;
    const nameEl = $('#user-name');
    const mailEl = $('#user-mail');
    const avEl = $('#user-avatar');
    if (nameEl) nameEl.textContent = user.name || user.email || 'Administrador';
    if (mailEl) mailEl.textContent = user.email || '—';
    if (avEl) avEl.textContent = initials(user.name || user.email);
  } catch {
    const nameEl = $('#user-name');
    if (nameEl) nameEl.textContent = 'Administrador';
  }
}

/* ─── Boot ────────────────────────────────────────────────────────────────── */

function bindEvents() {
  $$('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => setView(btn.dataset.view));
  });

  $$('[data-goto]').forEach((btn) => {
    btn.addEventListener('click', () => setView(btn.dataset.goto));
  });

  $('#refresh-btn')?.addEventListener('click', () => {
    refreshAll();
    toast('Datos actualizados', 'ok');
  });

  $('#menu-toggle')?.addEventListener('click', () => {
    $('#sidebar')?.classList.toggle('is-open');
  });

  $('#logout-btn')?.addEventListener('click', async () => {
    try {
      await api('/api/auth/logout', { method: 'POST', body: {} });
    } catch {
      /* se redirige igual */
    }
    window.location.href = '/login';
  });

  // Usuarios: búsqueda con debounce
  let searchTimer = null;
  $('#users-search')?.addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    const value = e.target.value.trim();
    searchTimer = setTimeout(() => {
      STATE.users.q = value;
      STATE.users.page = 0;
      loadUsers();
    }, 320);
  });

  $('#users-role')?.addEventListener('change', (e) => {
    STATE.users.role = e.target.value;
    STATE.users.page = 0;
    loadUsers();
  });

  $('#users-plan')?.addEventListener('change', (e) => {
    STATE.users.plan = e.target.value;
    STATE.users.page = 0;
    loadUsers();
  });

  $('#users-reload')?.addEventListener('click', () => loadUsers());
  $('#users-prev')?.addEventListener('click', () => {
    if (STATE.users.page > 0) { STATE.users.page--; loadUsers(); }
  });
  $('#users-next')?.addEventListener('click', () => {
    if (STATE.users.page + 1 < STATE.users.pages) { STATE.users.page++; loadUsers(); }
  });

  $('#payments-status')?.addEventListener('change', (e) => {
    STATE.payments.status = e.target.value;
    STATE.payments.page = 0;
    loadPayments();
  });
  $('#payments-reload')?.addEventListener('click', () => loadPayments());
  $('#payments-prev')?.addEventListener('click', () => {
    if (STATE.payments.page > 0) { STATE.payments.page--; loadPayments(); }
  });
  $('#payments-next')?.addEventListener('click', () => {
    if (STATE.payments.page + 1 < STATE.payments.pages) { STATE.payments.page++; loadPayments(); }
  });

  $('#logs-level')?.addEventListener('change', (e) => {
    STATE.logs.level = e.target.value;
    STATE.logs.page = 0;
    loadLogs();
  });
  $('#logs-reload')?.addEventListener('click', () => loadLogs());
  $('#logs-prev')?.addEventListener('click', () => {
    if (STATE.logs.page > 0) { STATE.logs.page--; loadLogs(); }
  });
  $('#logs-next')?.addEventListener('click', () => {
    if (STATE.logs.page + 1 < STATE.logs.pages) { STATE.logs.page++; loadLogs(); }
  });

  // Acciones de fila (banear / desbanear)
  $('#users-table')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action="toggle-ban"]');
    if (!btn) return;
    const id = btn.dataset.id;
    const userId = btn.closest('tr')?.dataset.userId;
    if (!userId) return;
    btn.disabled = true;
    try {
      await api(`/api/admin/users/${encodeURIComponent(userId)}`, {
        method: 'PATCH',
        body: { action: btn.dataset.action === 'toggle-ban' ? 'toggle_ban' : 'toggle_ban' },
      });
      toast('Usuario actualizado', 'ok');
      loadUsers();
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false;
    }
  });

  // Pausa el auto-refresh cuando la pestaña está oculta
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      clearInterval(STATE.timer);
      STATE.timer = null;
    } else if (!STATE.timer) {
      startTimer();
      refreshAll();
    }
  });

  window.addEventListener('resize', () => {
    if (STATE.chartRenderer === 'canvas-fallback' && STATE.stats?.revenueByDay) {
      drawFallbackChart($('#revenue-chart'), STATE.stats.revenueByDay);
    }
  });
}

function startTimer() {
  if (STATE.timer) clearInterval(STATE.timer);
  STATE.timer = setInterval(() => {
    if (document.hidden) return;
    refreshAll();
  }, REFRESH_MS);
}

async function boot() {
  if (STATE.booted) return;
  STATE.booted = true;
  injectAdminStyles();
  bindEvents();
  loadSession();
  await refreshAll();
  startTimer();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}

window.NumAdmin = { refreshAll, setView, loadStats, loadUsers, loadPayments, loadLogs };
