// Lógica principal de las partidas: lobby, turnos, muerte con regreso, reconexión.
const { EventEmitter } = require('events');
const crypto = require('crypto');
const store = require('./store');
const story = require('./story');
const { SKINS, isValidSkin } = require('./skins');

const events = new EventEmitter(); // 'update' (code) y 'fx' ({code,type,text})
const MAX_PLAYERS = 3;
const TURN_SECONDS = Number(process.env.TURN_SECONDS) || 120;
const CHECKPOINT_EVERY = 3;

const timers = new Map(); // code -> timeout del turno
const busy = new Set(); // partidas cuya siguiente escena se está generando
const presence = new Map(); // "code:playerId" -> nº de conexiones abiertas (solo en memoria)

const clean = (n) => String(n || '').replace(/[<>]/g, '').trim().slice(0, 20) || 'Viajero';
const skinOr = (s) => (isValidSkin(s) ? s : SKINS[0].id);
const clone = (o) => JSON.parse(JSON.stringify(o));

function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c;
  do {
    c = '';
    for (let i = 0; i < 5; i++) c += chars[crypto.randomInt(chars.length)];
  } while (store.get(c));
  return c;
}

function newPlayer(id, name, skin) {
  return {
    id,
    name: clean(name),
    skin: skinOr(skin),
    leftAtTurn: null, // turno en el que se fue (null = está o nunca se fue)
    reunion: false, // vuelve al grupo y la IA debe narrar su reaparición
    memories: [], // recuerdos de muertes: se conservan al regresar
  };
}

function online(code, pid) {
  return (presence.get(code + ':' + pid) || 0) > 0;
}
function anyOnline(g) {
  return g.order.some((id) => online(g.code, id));
}

function changed(code) {
  const g = store.get(code);
  if (!g) return;
  store.put(g);
  events.emit('update', code);
}

// ---------- Crear / unirse ----------
function createGame({ playerId, name, skin }) {
  if (typeof playerId !== 'string' || playerId.length < 8) throw new Error('Identificador de jugador no válido.');
  const code = makeCode();
  const g = {
    code,
    hostId: playerId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    phase: 'lobby',
    players: { [playerId]: newPlayer(playerId, name, skin) },
    order: [playerId],
    turn: 0,
    deaths: 0,
    scene: null,
    summary: '',
    choices: {},
    deadline: null,
    log: [],
    checkpoints: [],
  };
  store.put(g);
  return g;
}

// El jugador se conecta (o reconecta) a una partida.
function attach(code, { playerId, name, skin }) {
  const g = store.get(code);
  if (!g) throw new Error('No existe ninguna partida con ese código.');
  if (typeof playerId !== 'string' || playerId.length < 8) throw new Error('Identificador de jugador no válido.');

  let p = g.players[playerId];
  if (!p) {
    if (g.order.length >= MAX_PLAYERS) throw new Error(`La partida ya tiene ${MAX_PLAYERS} jugadores.`);
    p = g.players[playerId] = newPlayer(playerId, name, skin);
    g.order.push(playerId);
    // Si llega con la historia en marcha, aparece en la escena actual.
    p.leftAtTurn = g.phase === 'playing' ? g.turn : null;
    g.log.push({ type: 'system', turn: g.turn, text: `${p.name} se ha unido a la partida.` });
  } else if (p.leftAtTurn !== null) {
    g.log.push({ type: 'system', turn: g.turn, text: `${p.name} vuelve a la partida.` });
  }

  let missed = [];
  if (p.leftAtTurn !== null) {
    missed = g.log.filter((e) => e.type === 'scene' && e.turn >= p.leftAtTurn).slice(-6);
    if (g.phase === 'playing') p.reunion = true;
    p.leftAtTurn = null;
  }

  const key = g.code + ':' + playerId;
  presence.set(key, (presence.get(key) || 0) + 1);
  store.put(g);
  return { g, p, missed };
}

// Llamar tras attach: arranca el temporizador si hace falta y avisa a todos.
function afterAttach(code) {
  const g = store.get(code);
  if (g && g.phase === 'playing' && !timers.has(code) && !busy.has(code)) armTimer(code);
  changed(code);
}

// El jugador se desconecta o sale.
function detach(code, pid) {
  const key = code + ':' + pid;
  const n = (presence.get(key) || 0) - 1;
  if (n > 0) {
    presence.set(key, n);
    return;
  }
  presence.delete(key);
  const g = store.get(code);
  if (!g || !g.players[pid]) return;

  if (g.phase === 'playing') g.players[pid].leftAtTurn = busy.has(code) ? g.turn + 1 : g.turn;
  g.log.push({ type: 'system', turn: g.turn, text: `${g.players[pid].name} se ha ido. Su personaje queda en pausa.` });
  if (!anyOnline(g)) {
    clearTimer(code);
    g.deadline = null;
  }
  changed(code);
  maybeResolve(code);
}

function setSkin(code, pid, skin) {
  const g = store.get(code);
  if (!g || !g.players[pid]) throw new Error('Partida no encontrada.');
  g.players[pid].skin = skinOr(skin);
  changed(code);
}

// ---------- Temporizador y turnos ----------
function clearTimer(code) {
  const t = timers.get(code);
  if (t) {
    clearTimeout(t);
    timers.delete(code);
  }
}

function armTimer(code) {
  clearTimer(code);
  const g = store.get(code);
  if (!g || g.phase !== 'playing' || busy.has(code) || !g.scene) return;
  if (!anyOnline(g)) {
    g.deadline = null;
    return;
  }
  g.deadline = Date.now() + TURN_SECONDS * 1000;
  timers.set(
    code,
    setTimeout(() => {
      timers.delete(code);
      onTimeout(code);
    }, TURN_SECONDS * 1000)
  );
}

async function onTimeout(code) {
  const g = store.get(code);
  if (!g || g.phase !== 'playing' || !g.scene) return;
  // Quien no decidió a tiempo: el destino decide por él.
  for (const id of g.order) {
    if (online(code, id) && g.choices[id] === undefined) {
      g.choices[id] = crypto.randomInt(g.scene.options.length);
    }
  }
  await resolveTurn(code);
}

function maybeResolve(code) {
  const g = store.get(code);
  if (!g || g.phase !== 'playing' || busy.has(code) || !g.scene) return;
  const onl = g.order.filter((id) => online(code, id));
  if (onl.length && onl.every((id) => g.choices[id] !== undefined)) resolveTurn(code);
}

function snapshot(g) {
  return {
    location: g.scene ? g.scene.location : '',
    summary: g.summary || '',
    players: g.order.map((id) => ({ name: g.players[id].name, memories: g.players[id].memories.slice(-3) })),
    recent: g.log
      .filter((e) => e.type === 'scene')
      .slice(-3)
      .map((e) => ({ narration: e.narration })),
    deaths: g.deaths,
  };
}

function applyScene(g, next) {
  g.scene = { narration: next.narration, location: next.location, options: next.options };
  g.summary = next.summary;
  if (next.checkpoint || g.turn % CHECKPOINT_EVERY === 0) {
    g.checkpoints.push({ turn: g.turn, scene: clone(g.scene), summary: g.summary, logLength: g.log.length });
    if (g.checkpoints.length > 30) g.checkpoints.shift();
  }
}

// Aplica el resultado de la IA: puede provocar una muerte y un regreso.
function applyNext(g, next, present) {
  const dying = [];
  for (const d of next.deaths || []) {
    const id = present.find((pid) => g.players[pid].name === d.name);
    if (id && !dying.some((x) => x.id === id)) dying.push({ id, memory: d.memory });
  }

  const cp = g.checkpoints[g.checkpoints.length - 1];
  if (dying.length && cp) {
    const names = dying.map((d) => g.players[d.id].name);
    for (const d of dying) {
      g.players[d.id].memories.push(d.memory || 'Recuerdas el último instante antes de morir.');
    }
    g.deaths += 1;
    // Regreso por la muerte: el mundo vuelve al último punto de guardado.
    g.log = g.log.slice(0, cp.logLength);
    const text =
      `${joinNames(names)} ${names.length > 1 ? 'han muerto' : 'ha muerto'}. ` +
      `El mundo vuelve al último punto de guardado... pero ${names.length > 1 ? 'ellos' : names[0]} lo recuerda.`;
    g.log.push({ type: 'rewind', turn: cp.turn, text });
    g.scene = clone(cp.scene);
    g.summary = cp.summary;
    g.turn = cp.turn;
    events.emit('fx', { code: g.code, type: 'rewind', text });
    return;
  }

  applyScene(g, next);
}

function joinNames(arr) {
  return arr.length <= 1 ? arr.join('') : `${arr.slice(0, -1).join(', ')} y ${arr[arr.length - 1]}`;
}

async function resolveTurn(code) {
  const g = store.get(code);
  if (!g || !g.scene || busy.has(code)) return;
  busy.add(code);
  clearTimer(code);
  g.deadline = null;
  changed(code);

  try {
    const scene = g.scene;
    const present = g.order.filter((id) => online(code, id));
    const actions = present.map((id) => {
      const idx = g.choices[id] !== undefined ? g.choices[id] : crypto.randomInt(scene.options.length);
      return { name: g.players[id].name, choice: scene.options[idx] };
    });
    const absent = g.order.filter((id) => !online(code, id)).map((id) => g.players[id].name);
    const reunions = present.filter((id) => g.players[id].reunion).map((id) => g.players[id].name);

    const next = await story.nextScene({
      intro: false,
      turn: g.turn,
      state: snapshot(g),
      scene,
      actions,
      absent,
      reunions,
    });

    g.log.push({ type: 'scene', turn: g.turn, narration: scene.narration, actions });
    g.choices = {};
    g.turn += 1;
    for (const id of present) g.players[id].reunion = false;
    applyNext(g, next, present);
  } catch (e) {
    console.error('Error al resolver el turno:', e);
  } finally {
    busy.delete(code);
  }
  armTimer(code);
  changed(code);
}

// ---------- Acciones de los jugadores ----------
async function start(code, pid) {
  const g = store.get(code);
  if (!g) throw new Error('Partida no encontrada.');
  if (g.hostId !== pid) throw new Error('Solo quien creó la partida puede empezarla.');
  if (g.phase !== 'lobby') return;
  if (busy.has(code)) return;

  g.phase = 'playing';
  g.turn = 0;
  busy.add(code);
  changed(code);
  try {
    const absent = [];
    const next = await story.nextScene({
      intro: true,
      turn: 0,
      state: snapshot(g),
      scene: null,
      actions: [],
      absent,
      reunions: [],
    });
    applyScene(g, next);
  } catch (e) {
    console.error('Error al empezar la partida:', e);
  } finally {
    busy.delete(code);
  }
  armTimer(code);
  changed(code);
}

function choose(code, pid, index) {
  const g = store.get(code);
  if (!g) throw new Error('Partida no encontrada.');
  if (g.phase !== 'playing') throw new Error('La historia aún no ha empezado.');
  if (!g.players[pid]) throw new Error('No estás en esta partida.');
  if (busy.has(code)) throw new Error('La historia se está escribiendo, espera un momento.');
  if (!g.scene || !Number.isInteger(index) || index < 0 || index >= g.scene.options.length) {
    throw new Error('Opción no válida.');
  }
  g.choices[pid] = index;
  changed(code);
  maybeResolve(code);
}

// ---------- Vistas ----------
function publicState(g) {
  return {
    code: g.code,
    phase: g.phase,
    hostId: g.hostId,
    turn: g.turn,
    deaths: g.deaths,
    deadline: g.deadline || null,
    resolving: busy.has(g.code),
    turnSeconds: TURN_SECONDS,
    maxPlayers: MAX_PLAYERS,
    usingAI: story.usingAI(),
    players: g.order.map((id) => {
      const p = g.players[id];
      return {
        id,
        name: p.name,
        skin: p.skin,
        online: online(g.code, id),
        chose: g.choices[id] !== undefined,
        memories: p.memories.slice(-4),
      };
    }),
    scene: g.scene ? { location: g.scene.location, narration: g.scene.narration, options: g.scene.options } : null,
    log: g.log.slice(-40),
  };
}

function listGamesFor(pid) {
  return store
    .all()
    .filter((g) => g.players[pid])
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((g) => ({
      code: g.code,
      phase: g.phase,
      turn: g.turn,
      updatedAt: g.updatedAt,
      location: g.scene ? g.scene.location : '',
      players: g.order.map((id) => g.players[id].name),
    }));
}

module.exports = {
  events,
  MAX_PLAYERS,
  TURN_SECONDS,
  createGame,
  attach,
  afterAttach,
  detach,
  setSkin,
  start,
  choose,
  publicState,
  listGamesFor,
  store,
};
