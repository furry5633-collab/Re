const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const store = require('./store');
const game = require('./game');
const story = require('./story');
const { SKINS } = require('./skins');

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/healthz', (req, res) => res.send('ok'));

app.get('/api/config', (req, res) => {
  res.json({
    skins: SKINS,
    usingAI: story.usingAI(),
    maxPlayers: game.MAX_PLAYERS,
    turnSeconds: game.TURN_SECONDS,
  });
});

app.post('/api/games', (req, res) => {
  try {
    const g = game.createGame(req.body || {});
    res.json({ code: g.code });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/my-games', (req, res) => {
  res.json(game.listGamesFor(String(req.query.playerId || '')));
});

const server = http.createServer(app);
const io = new Server(server, { pingInterval: 20000, pingTimeout: 40000 });

// Envía a cada socket el estado público + su propia elección (las elecciones de los demás son secretas).
async function broadcast(code) {
  const g = store.get(code);
  if (!g) return;
  const pub = game.publicState(g);
  const sockets = await io.in(code).fetchSockets();
  for (const s of sockets) {
    s.emit('state', { ...pub, myChoice: g.choices[s.data.playerId] ?? null });
  }
}

game.events.on('update', (code) => broadcast(code));
game.events.on('fx', (fx) => io.to(fx.code).emit('fx', fx));

function leave(socket) {
  const { code, playerId } = socket.data;
  if (!code) return;
  socket.leave(code);
  socket.data.code = null;
  game.detach(code, playerId);
}

io.on('connection', (socket) => {
  socket.on('game:join', (data = {}, ack = () => {}) => {
    try {
      const code = String(data.code || '').toUpperCase().trim();
      if (socket.data.code) leave(socket); // si estaba en otra partida, sale de ella
      const { g, p, missed } = game.attach(code, data);
      socket.join(g.code);
      socket.data.code = g.code;
      socket.data.playerId = p.id;
      if (missed.length) socket.emit('returned', { missed });
      game.afterAttach(g.code);
      ack({ ok: true, code: g.code });
    } catch (e) {
      ack({ ok: false, error: e.message });
    }
  });

  socket.on('game:start', async (_, ack = () => {}) => {
    try {
      await game.start(socket.data.code, socket.data.playerId);
      ack({ ok: true });
    } catch (e) {
      ack({ ok: false, error: e.message });
    }
  });

  socket.on('game:choose', (data = {}, ack = () => {}) => {
    try {
      game.choose(socket.data.code, socket.data.playerId, Number(data.index));
      ack({ ok: true });
    } catch (e) {
      ack({ ok: false, error: e.message });
    }
  });

  socket.on('game:skin', (data = {}, ack = () => {}) => {
    try {
      game.setSkin(socket.data.code, socket.data.playerId, data.skin);
      ack({ ok: true });
    } catch (e) {
      ack({ ok: false, error: e.message });
    }
  });

  socket.on('game:leave', (_, ack = () => {}) => {
    leave(socket);
    ack({ ok: true });
  });

  socket.on('disconnect', () => leave(socket));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Re:Zero multijugador en http://0.0.0.0:${PORT}`);
  console.log(story.usingAI() ? 'Narrador: IA' : 'Narrador: local (sin clave de IA)');
});

function shutdown() {
  store.flush();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
