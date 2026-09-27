/* ================================================================
   NUMINATION · skills.js
   Sistema de skills (habilidades) reutilizables.
   Cada skill = un prompt predefinido que se inyecta en el composer.
   ================================================================ */

(function () {
  'use strict';

  var STORAGE_KEY = 'numination-skills-v1';

  /* ══════════════════════════════════════════════════════════════
     CATÁLOGO DE SKILLS
     ══════════════════════════════════════════════════════════════ */
  var SKILLS = [
    {
      id: 'explicar-simple',
      name: 'Explicar simple',
      desc: 'Como si tuviera 10 años',
      icon: '📘',
      prompt: 'Explícame lo siguiente como si tuviera 10 años, con un ejemplo de la vida cotidiana en Colombia:\n\n'
    },
    {
      id: 'paso-a-paso',
      name: 'Paso a paso',
      desc: 'Resolver con pasos numerados',
      icon: '🪜',
      prompt: 'Resuelve esto paso a paso, numerando cada paso y verificando comprensión al final:\n\n'
    },
    {
      id: 'resumen-5',
      name: 'Resumen en 5',
      desc: '5 ideas clave',
      icon: '📝',
      prompt: 'Resume el siguiente texto en 5 ideas clave y dime cuál es la idea principal:\n\n'
    },
    {
      id: 'preguntas-repaso',
      name: 'Preguntas de repaso',
      desc: '8 preguntas de práctica',
      icon: '❓',
      prompt: 'Hazme 8 preguntas de repaso sobre el siguiente tema, de menor a mayor dificultad, con sus respuestas:\n\n'
    },
    {
      id: 'mnemotecnia',
      name: 'Mnemotecnia',
      desc: 'Regla para memorizar',
      icon: '🧠',
      prompt: 'Dame una regla mnemotécnica divertida y fácil de recordar para:\n\n'
    },
    {
      id: 'analogia',
      name: 'Analogía simple',
      desc: 'Con algo cotidiano',
      icon: '🔗',
      prompt: 'Explícame esto usando una analogía de la vida diaria colombiana:\n\n'
    },
    {
      id: 'corregir-texto',
      name: 'Corregir texto',
      desc: 'Ortografía y redacción',
      icon: '✅',
      prompt: 'Corrige la ortografía y redacción del siguiente texto, y explícame los errores:\n\n'
    },
    {
      id: 'mejorar-escritura',
      name: 'Mejorar escritura',
      desc: 'Más claro y directo',
      icon: '✏️',
      prompt: 'Mejora la redacción del siguiente texto para que quede más clara y directa, sin cambiar el significado:\n\n'
    },
    {
      id: 'ensayo',
      name: 'Ensayo argumentativo',
      desc: 'Con tesis y argumentos',
      icon: '📄',
      prompt: 'Ayúdame a estructurar un ensayo sobre esto, con tesis, 3 argumentos y conclusión:\n\n'
    },
    {
      id: 'plan-clase',
      name: 'Plan de clase',
      desc: '45 min estructurados',
      icon: '📅',
      prompt: 'Diseña un plan de clase de 45 minutos sobre esto, con objetivos, actividades y evaluación:\n\n'
    },
    {
      id: 'rubrica',
      name: 'Rúbrica',
      desc: 'Criterios de evaluación',
      icon: '📊',
      prompt: 'Crea una rúbrica de evaluación para la siguiente actividad, con 4 niveles de desempeño:\n\n'
    },
    {
      id: 'adaptacion-dua',
      name: 'Adaptación DUA',
      desc: 'Para diversidad en el aula',
      icon: '👥',
      prompt: 'Adapta la siguiente actividad para estudiantes con necesidades específicas, sin perder el objetivo pedagógico:\n\n'
    },
    {
      id: 'explicar-codigo',
      name: 'Explicar código',
      desc: 'Línea por línea',
      icon: '💻',
      prompt: 'Explícame el siguiente código línea por línea, qué hace y por qué:\n\n'
    },
    {
      id: 'debug',
      name: 'Debug',
      desc: 'Encontrar el bug',
      icon: '🐛',
      prompt: 'Encuentra y explica el error en el siguiente código. Dame la corrección:\n\n'
    },
    {
      id: 'optimizar',
      name: 'Optimizar',
      desc: 'Más rápido y limpio',
      icon: '⚡',
      prompt: 'Optimiza el siguiente código: hazlo más rápido, más limpio y explícame qué cambiaste:\n\n'
    },
    {
      id: 'lluvia-ideas',
      name: 'Lluvia de ideas',
      desc: '10 ideas sobre el tema',
      icon: '💡',
      prompt: 'Dame 10 ideas originales sobre lo siguiente, ordenadas de más común a más creativa:\n\n'
    },
    {
      id: 'imagen',
      name: 'Imagen educativa',
      desc: 'Generar ilustración',
      icon: '🎨',
      prompt: 'Genera una imagen educativa sobre esto que pueda usar en clase:\n\n'
    },
    {
      id: 'guion',
      name: 'Guion de video',
      desc: 'Para exposición',
      icon: '🎬',
      prompt: 'Escribe un guion de 2 minutos para un video sobre lo siguiente, con introducción, desarrollo y cierre:\n\n'
    }
  ];

  /* ══════════════════════════════════════════════════════════════
     ESTADO
     ══════════════════════════════════════════════════════════════ */
  var state = {
    custom: loadCustom()
  };

  function loadCustom() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) { return []; }
  }

  function saveCustom() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.custom)); } catch (e) {}
  }

  /* ══════════════════════════════════════════════════════════════
     API PÚBLICA
     ══════════════════════════════════════════════════════════════ */
  function list() {
    return SKILLS.concat(state.custom);
  }

  function apply(id) {
    var skill = list().find(function (s) { return s.id === id; });
    if (!skill) return;

    var field = document.querySelector('[data-chat-field]');
    if (!field) return;

    var existing = field.value.trim();
    field.value = existing ? skill.prompt + existing : skill.prompt;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.focus();

    setTimeout(function () {
      field.selectionStart = field.selectionEnd = field.value.length;
    }, 0);

    if (window.__numination && window.__numination.Toasts) {
      window.__numination.Toasts.info('Skill aplicada: ' + skill.name);
    }
  }

  function add(skill) {
    if (!skill || !skill.name || !skill.prompt) return false;
    var id = 'custom_' + Date.now();
    state.custom.push({
      id: id,
      name: skill.name,
      desc: skill.desc || 'Personalizada',
      icon: skill.icon || '⭐',
      prompt: skill.prompt
    });
    saveCustom();
    return true;
  }

  function remove(id) {
    state.custom = state.custom.filter(function (s) { return s.id !== id; });
    saveCustom();
  }

  /* ══════════════════════════════════════════════════════════════
     EXPONER
     ══════════════════════════════════════════════════════════════ */
  window.__nmSkills = {
    list: list,
    apply: apply,
    add: add,
    remove: remove
  };

  console.log('[skills] cargado ·', SKILLS.length, 'skills disponibles');
})();