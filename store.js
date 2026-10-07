// Persistencia sencilla: un fichero JSON con todas las partidas.
// En Render (plan gratis) el disco se borra al reiniciar; ver README para usar un disco persistente.
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'games.json');

let games = {};
try {
  games = JSON.parse(fs.readFileSync(FILE, 'utf8'));
} catch {
  games = {};
}

let saveTimer = null;

function flush() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(games));
    fs.renameSync(tmp, FILE);
  } catch (e) {
    console.error('No se pudo guardar la partida:', e.message);
  }
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 250);
}

module.exports = {
  get: (code) => games[code] || null,
  put(game) {
    game.updatedAt = Date.now();
    games[game.code] = game;
    save();
    return game;
  },
  all: () => Object.values(games),
  flush,
};
