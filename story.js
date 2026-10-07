// Generación de escenas: usa una IA compatible con la API de OpenAI si hay clave,
// y si no hay clave (o falla) usa un narrador local para que el juego siempre funcione.

const SYSTEM_PROMPT = `Eres el narrador de un juego de rol de texto multijugador inspirado en Re:Zero (fan game no oficial).
Los jugadores son forasteros transportados de repente a un mundo de fantasía. Tono cercano al anime: misterio, peligro real,
personajes con personalidad y momentos humanos. Usa nombres, lugares y criaturas originales.

Reglas:
1. Escribe SIEMPRE en español.
2. "narration": 90-170 palabras. Narra, en orden, las acciones de cada personaje presente, con consecuencias lógicas respecto a lo ocurrido antes.
   Los personajes AUSENTES no aparecen en la escena.
3. Si hay "Reencuentros", narra la reaparición del personaje en el momento exacto en que se fue (sin saber lo que pasó mientras tanto) y cómo se reúne con el grupo, en 1-2 frases.
4. "options": exactamente 3 acciones distintas que pueda elegir cada personaje, de 4 a 14 palabras, en infinitivo (ej.: "Seguir el rastro del humo").
   Varíalas: una prudente, una arriesgada y una social o curiosa.
5. "deaths": lista vacía salvo que un personaje PRESENTE muera de forma explícita por lo que ha hecho. Las muertes son raras y deben tener sentido
   (una acción temeraria frente a un peligro real). Cada muerte incluye "memory": 1-2 frases en primera persona de lo que el personaje recuerda de su muerte.
6. "checkpoint": true si esta escena es un buen punto de guardado (un refugio seguro o un momento clave).
7. "summary": resumen acumulado de la historia en 3-6 frases (personajes, lugares y hechos clave).
8. "location": nombre corto del lugar actual.

Devuelve SOLO un objeto JSON válido con las claves: narration, location, summary, options, deaths, checkpoint.`;

const LOCATIONS = [
  'un bosque nevado de pinos negros',
  'una aldea medio derruida al borde de un lago',
  'la capital amurallada, con calles llenas de mercaderes',
  'una isla rocosa con un santuario antiguo',
  'un camino que se bifurca entre montañas',
  'las ruinas de una torre que flota sobre la niebla',
  'un puerto con barcos que nadie reclama',
];

const THREATS = [
  'un lobo de escarcha del tamaño de un caballo',
  'un caballero de armadura negra que no habla',
  'un mercader que sonríe demasiado',
  'una voz que imita a quien la escucha',
  'una tormenta de niebla que llega de golpe',
  'una patrulla de guardias con antorchas',
];

const POOL = [
  { text: 'Investigar de dónde viene el ruido', risk: false },
  { text: 'Esconderse y observar en silencio', risk: false },
  { text: 'Acercarse al desconocido para hablarle', risk: false },
  { text: 'Correr hacia la salida más cercana', risk: true },
  { text: 'Atacar antes de que reaccionen', risk: true },
  { text: 'Buscar ayuda en el pueblo más cercano', risk: false },
  { text: 'Revisar las pertenencias del viajero caído', risk: false },
  { text: 'Preguntar a los lugareños qué día es hoy', risk: false },
  { text: 'Sacar la espada y avanzar', risk: true },
  { text: 'Encender una fogata y descansar', risk: false },
  { text: 'Seguir el rastro de sangre', risk: true },
  { text: 'Cruzar el río a nado', risk: true },
  { text: 'Dibujar un mapa de la zona', risk: false },
  { text: 'Negociar con la criatura', risk: false },
];

const CONSEQUENCES = [
  'Nadie se da cuenta, por ahora.',
  'La tensión sube un grado.',
  'El resultado no es el que esperabas, pero sirve.',
  'Algo en el aire cambia.',
  'El silencio se rompe con un crujido.',
];

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const shuffle = (arr) => [...arr].sort(() => Math.random() - 0.5);
const joinNames = (arr) =>
  arr.length <= 1 ? arr.join('') : `${arr.slice(0, -1).join(', ')} y ${arr[arr.length - 1]}`;

function usingAI() {
  return !!(process.env.LLM_API_KEY || process.env.OPENAI_API_KEY);
}

// ---------- Narrador local (sin IA) ----------
function offlineScene(ctx) {
  const names = ctx.state.players.map((p) => p.name);
  const location = ctx.intro ? pick(LOCATIONS) : ctx.state.location || pick(LOCATIONS);
  const threat = pick(THREATS);
  const parts = [];

  if (ctx.intro) {
    parts.push(
      `Un parpadeo, un silencio que pesa como agua... y de pronto ${joinNames(names)} despiertan en ${location}, sin recordar cómo han llegado.`
    );
    parts.push(`A lo lejos, ${threat} se mueve entre la niebla.`);
  } else {
    if (ctx.reunions.length) {
      parts.push(
        `${joinNames(ctx.reunions)} aparece entre los árboles, jadeando: ha vuelto justo al punto donde se fue.`
      );
    }
    parts.push(`Mientras tanto, ${threat} se acerca.`);
    for (const a of ctx.actions) {
      parts.push(`${a.name} decide: "${a.choice}". ${pick(CONSEQUENCES)}`);
    }
    if (ctx.absent.length) {
      parts.push(`${joinNames(ctx.absent)} no está en esta escena: su historia sigue en otro lugar.`);
    }
  }

  const deaths = [];
  if (!ctx.intro) {
    for (const a of ctx.actions) {
      const risky = POOL.find((o) => o.text === a.choice)?.risk;
      if (risky && Math.random() < 0.25) {
        deaths.push({
          name: a.name,
          memory: `Lo último que recuerdas es ${threat} cerrándose sobre ti. Despiertas sin saber cuánto tiempo ha pasado, pero no olvidarás esa mirada.`,
        });
        break;
      }
    }
  }

  const options = shuffle(POOL).slice(0, 3).map((o) => o.text);
  const prev = ctx.state.summary ? ctx.state.summary + ' ' : '';
  const summary = (
    prev +
    (ctx.intro
      ? `Los forasteros llegan a ${location}.`
      : `Turno ${ctx.turn}: ${ctx.actions.map((a) => `${a.name} ${a.choice.toLowerCase()}`).join('; ') || 'el grupo espera'}.`)
  ).slice(-1200);

  return {
    narration: parts.join(' '),
    location,
    summary,
    options,
    deaths,
    checkpoint: false,
  };
}

// ---------- Narrador con IA (API compatible con OpenAI) ----------
function buildUserMessage(ctx) {
  const s = ctx.state;
  const lines = [];
  lines.push(
    `Turno: ${ctx.turn}${ctx.intro ? ' (LLEGADA: los personajes acaban de aparecer en el mundo tras taparse un ojo; narra su llegada brusca)' : ''}`
  );
  lines.push(`Ubicación: ${s.location || 'desconocida'}`);
  lines.push(`Resumen de la historia: ${s.summary || '(aún no hay historia)'}`);
  lines.push(`Personajes del grupo: ${s.players.map((p) => p.name).join(', ')}`);
  lines.push(`Ausentes (no están en la escena): ${ctx.absent.join(', ') || 'ninguno'}`);
  lines.push(`Reencuentros: ${ctx.reunions.join(', ') || 'ninguno'}`);
  const mem = s.players.filter((p) => p.memories.length).map((p) => `${p.name}: ${p.memories.join(' | ')}`);
  lines.push(`Recuerdos de muertes anteriores (solo ellos los conservan): ${mem.join('; ') || 'ninguno'}`);
  if (s.recent.length) {
    lines.push(`Sucesos recientes:\n${s.recent.map((r) => `- ${r.narration}`).join('\n')}`);
  }
  if (!ctx.intro) {
    lines.push(`Escena actual:\n${ctx.scene.narration}`);
    lines.push(
      `Acciones elegidas en esta escena:\n${ctx.actions.map((a) => `- ${a.name}: "${a.choice}"`).join('\n') || '- (nadie ha actuado)'}`
    );
  }
  lines.push('Responde solo con el JSON pedido.');
  return lines.join('\n');
}

function extractJSON(text) {
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) throw new Error('La IA no devolvió JSON');
  return JSON.parse(m[0]);
}

async function callLLM(ctx) {
  const key = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY;
  const base = (process.env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const model = process.env.LLM_MODEL || 'gpt-4o-mini';

  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      temperature: 0.9,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserMessage(ctx) },
      ],
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`Error de la IA ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return extractJSON(data.choices[0].message.content);
}

function validate(o) {
  if (!o || typeof o.narration !== 'string' || o.narration.trim().length < 30) return null;
  let options = Array.isArray(o.options)
    ? o.options.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim().slice(0, 140))
    : [];
  options = [...new Set(options)].slice(0, 3);
  for (const o2 of shuffle(POOL)) {
    if (options.length >= 3) break;
    if (!options.includes(o2.text)) options.push(o2.text);
  }
  return {
    narration: o.narration.trim(),
    location: String(o.location || '').slice(0, 120),
    summary: String(o.summary || '').slice(0, 1200),
    options,
    deaths: Array.isArray(o.deaths)
      ? o.deaths.filter((d) => d && d.name).map((d) => ({ name: String(d.name), memory: String(d.memory || '') }))
      : [],
    checkpoint: !!o.checkpoint,
  };
}

// Punto de entrada: genera la siguiente escena.
async function nextScene(ctx) {
  if (usingAI()) {
    try {
      const v = validate(await callLLM(ctx));
      if (v) return v;
      console.warn('Respuesta de la IA no válida; uso el narrador local para este turno.');
    } catch (e) {
      console.warn('Fallo de la IA; uso el narrador local:', e.message);
    }
  }
  return offlineScene(ctx);
}

module.exports = { nextScene, usingAI };
