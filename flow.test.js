// Pruebas: npm test
// 1) Lógica en proceso: muerte, regreso por la muerte y recuerdos.
// 2) Servidor real con sockets: partida, turnos, desconexión, reconexión, límite de jugadores, tiempo agotado.
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rz-test-'));
process.env.DATA_DIR = TMP;
process.env.TURN_SECONDS = '60';
delete process.env.LLM_API_KEY;
delete process.env.OPENAI_API_KEY;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 8000, label = 'condición') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v) return v;
    await sleep(50);
  }
  throw new Error('Tiempo agotado esperando: ' + label);
}

// ---------- 1) Pruebas en proceso ----------
async function unitTests() {
  const game = require('../server/game');
  const story = require('../server/story');
  let mode = 'normal';
  story.nextScene = async (ctx) => {
    if (ctx.intro) {
      return { narration: 'Llegada de prueba para el grupo de forasteros en el bosque.', location: 'Bosque', summary: 'Inicio', options: ['A', 'B', 'C'], deaths: [], checkpoint: false };
    }
    if (mode === 'death') {
      return {
        narration: 'Una escena en la que alguien muere de forma explícita tras una acción temeraria.',
        location: 'Bosque',
        summary: 'Muerte',
        options: ['D', 'E', 'F'],
        deaths: [{ name: ctx.actions[0].name, memory: 'Recuerdas el frío de sus garras.' }],
        checkpoint: false,
      };
    }
    return { narration: 'Escena normal de prueba con suficiente texto para validarse bien.', location: 'Claro', summary: 'Sigue', options: ['X', 'Y', 'Z'], deaths: [], checkpoint: false };
  };

  const pA = 'player-aaaaaaaaaa';
  const g = game.createGame({ playerId: pA, name: 'Subaru', skin: 'plata' });
  game.attach(g.code, { playerId: pA, name: 'Subaru', skin: 'plata' });
  await game.start(g.code, pA);
  let s = game.publicState(game.store.get(g.code));
  assert.strictEqual(s.phase, 'playing');
  assert.strictEqual(s.scene.options.length, 3);

  // Turno normal
  game.choose(g.code, pA, 0);
  await waitFor(() => game.store.get(g.code).turn === 1, 3000, 'turno 1');
  const cpCount1 = game.store.get(g.code).checkpoints.length;
  assert.strictEqual(game.store.get(g.code).log.length, 1);

  // Muerte: debe regresar al último punto de guardado (intro, turno 0)
  mode = 'death';
  game.choose(g.code, pA, 0);
  await waitFor(() => game.store.get(g.code).deaths === 1, 3000, 'muerte');
  const after = game.store.get(g.code);
  assert.strictEqual(after.turn, 0, 'debe volver al turno del punto de guardado');
  assert.strictEqual(after.scene.narration.startsWith('Llegada de prueba'), true, 'la escena vuelve al guardado');
  assert.strictEqual(after.log.length, 1, 'el registro se corta al punto de guardado');
  assert.strictEqual(after.log[0].type, 'rewind');
  assert.strictEqual(after.players[pA].memories.length, 1, 'el personaje conserva el recuerdo de la muerte');
  assert.ok(cpCount1 >= 1);
  console.log('  ✔ muerte, regreso al punto de guardado y recuerdos');

  // Partida con código inexistente
  assert.throws(() => game.attach('ZZZZZ', { playerId: 'player-bbbbbbbbbb', name: 'X' }), /No existe/);
  console.log('  ✔ código inexistente rechazado');
}

// ---------- 2) Servidor real con sockets ----------
function startServer(port, turnSeconds) {
  const env = { ...process.env, PORT: String(port), TURN_SECONDS: String(turnSeconds), DATA_DIR: fs.mkdtempSync(path.join(TMP, 's-')) };
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('El servidor no arrancó')), 8000);
    child.stdout.on('data', (d) => {
      if (String(d).includes('Re:Zero multijugador')) {
        clearTimeout(t);
        resolve(child);
      }
    });
  });
}

async function socketTests() {
  const { io } = require('socket.io-client');
  const PORT = 3911;
  const BASE = `http://127.0.0.1:${PORT}`;
  const server = await startServer(PORT, 60);

  const clients = [];
  function client() {
    const s = io(BASE, { transports: ['websocket'], forceNew: true, reconnection: false });
    const c = { s, state: null, returned: null, fx: [] };
    s.on('state', (st) => (c.state = st));
    s.on('returned', (r) => (c.returned = r));
    s.on('fx', (f) => c.fx.push(f));
    clients.push(c);
    return new Promise((res) => s.on('connect', () => res(c)));
  }
  const emit = (c, ev, data = {}) => new Promise((res) => c.s.emit(ev, data, res));

  try {
    const pA = 'player-aaaaaaaaaa';
    const pB = 'player-bbbbbbbbbb';
    const pC = 'player-cccccccccc';
    const pD = 'player-dddddddddd';

    // Crear partida por API
    const r = await fetch(`${BASE}/api/games`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: pA, name: 'Subaru', skin: 'plata' }),
    });
    const { code } = await r.json();
    assert.ok(/^[A-Z2-9]{5}$/.test(code), 'código con formato válido');

    const A = await client();
    const B = await client();
    let ack = await emit(A, 'game:join', { code, playerId: pA, name: 'Subaru', skin: 'plata' });
    assert.ok(ack.ok, ack.error);
    ack = await emit(B, 'game:join', { code, playerId: pB, name: 'Natsuki', skin: 'rosa' });
    assert.ok(ack.ok, ack.error);
    await waitFor(() => A.state && A.state.players.length === 2, 3000, 'dos jugadores en lobby');
    console.log('  ✔ crear partida, unirse con código, lobby con 2 jugadores');

    // Solo el anfitrión puede empezar
    ack = await emit(B, 'game:start');
    assert.strictEqual(ack.ok, false);
    ack = await emit(A, 'game:start');
    assert.ok(ack.ok, ack.error);
    await waitFor(() => A.state && A.state.scene, 5000, 'escena inicial');
    assert.strictEqual(A.state.phase, 'playing');
    console.log('  ✔ solo el anfitrión empieza; llega la escena inicial');

    // Opción inválida
    ack = await emit(A, 'game:choose', { index: 7 });
    assert.strictEqual(ack.ok, false);

    // Turno con ambos
    await emit(A, 'game:choose', { index: 0 });
    await waitFor(() => A.state && A.state.myChoice === 0, 2000, 'mi elección visible');
    assert.strictEqual(B.state.myChoice, null, 'las elecciones de otros son secretas');
    await emit(B, 'game:choose', { index: 1 });
    await waitFor(() => A.state && A.state.turn === 1, 5000, 'turno 1');
    const log1 = A.state.log.filter((e) => e.type === 'scene');
    assert.strictEqual(log1.length, 1);
    assert.strictEqual(log1[0].actions.length, 2);
    console.log('  ✔ ambos eligen, la IA/narrador resuelve y avanza el turno');

    // B se va: A decide sola y B queda en pausa
    B.s.disconnect();
    await sleep(300);
    await waitFor(() => A.state.players.find((p) => p.name === 'Natsuki').online === false, 3000, 'B ausente');
    await emit(A, 'game:choose', { index: 2 });
    await waitFor(() => A.state.turn === 2, 5000, 'turno 2 sin B');
    const scene2 = A.state.log.filter((e) => e.type === 'scene').pop();
    assert.strictEqual(scene2.actions.length, 1, 'B no actúa mientras está fuera');
    console.log('  ✔ si un jugador se va, la historia sigue sin él');

    // B vuelve: recibe lo que se perdió y se reúne con el grupo
    const B2 = await client();
    ack = await emit(B2, 'game:join', { code, playerId: pB, name: 'Natsuki', skin: 'rosa' });
    assert.ok(ack.ok, ack.error);
    await waitFor(() => B2.returned, 3000, 'recap al volver');
    assert.ok(B2.returned.missed.length >= 1, 'recibe el recap de lo que se perdió');
    await waitFor(() => A.state.players.find((p) => p.name === 'Natsuki').online === true, 3000, 'B vuelve');
    console.log('  ✔ al volver, el jugador recibe el recap de lo que se perdió');

    // Límite de 3 jugadores
    const C = await client();
    ack = await emit(C, 'game:join', { code, playerId: pC, name: 'Ram', skin: 'azul' });
    assert.ok(ack.ok, ack.error);
    const D = await client();
    ack = await emit(D, 'game:join', { code, playerId: pD, name: 'Rem', skin: 'verde' });
    assert.strictEqual(ack.ok, false, 'no se pueden unir más de 3');
    console.log('  ✔ máximo 3 jugadores');

    // Mis partidas
    const mine = await (await fetch(`${BASE}/api/my-games?playerId=${pB}`)).json();
    assert.ok(mine.some((g) => g.code === code), 'la partida aparece en Mis partidas');
    console.log('  ✔ la partida aparece en "Mis partidas" para quien ha jugado');

    // Salir y volver a entrar mantiene la partida
    await emit(C, 'game:leave');
    ack = await emit(C, 'game:join', { code, playerId: pC, name: 'Ram', skin: 'azul' });
    assert.ok(ack.ok);
    console.log('  ✔ salir y volver a entrar a la misma partida');
  } finally {
    clients.forEach((c) => c.s.disconnect());
    server.kill();
  }
}

async function timeoutTest() {
  const { io } = require('socket.io-client');
  const PORT = 3912;
  const BASE = `http://127.0.0.1:${PORT}`;
  const server = await startServer(PORT, 2);
  const p = 'player-tttttttttt';
  const s = io(BASE, { transports: ['websocket'], forceNew: true, reconnection: false });
  let st = null;
  s.on('state', (x) => (st = x));
  try {
    await new Promise((r) => s.on('connect', r));
    const { code } = await (
      await fetch(`${BASE}/api/games`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ playerId: p, name: 'Subaru' }) })
    ).json();
    await new Promise((res) => s.emit('game:join', { code, playerId: p, name: 'Subaru' }, res));
    await new Promise((res) => s.emit('game:start', {}, res));
    await waitFor(() => st && st.scene, 5000, 'escena');
    // No elige nada: a los 2 s el destino decide por él
    await waitFor(() => st && st.turn === 1, 6000, 'resolución automática por tiempo');
    console.log('  ✔ si nadie elige a tiempo, el destino decide y la historia avanza');
  } finally {
    s.disconnect();
    server.kill();
  }
}

(async () => {
  try {
    console.log('Pruebas de lógica:');
    await unitTests();
    console.log('Pruebas de servidor y sockets:');
    await socketTests();
    console.log('Pruebas de tiempo agotado:');
    await timeoutTest();
    console.log('\nTodo correcto ✅');
    process.exit(0);
  } catch (e) {
    console.error('\n❌ Fallo:', e);
    process.exit(1);
  }
})();
