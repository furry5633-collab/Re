(() => {
  const $ = (id) => document.getElementById(id);

  // Pequeño helper para crear elementos sin usar innerHTML (evita inyecciones).
  function el(tag, props = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'style') Object.assign(n.style, v);
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (k === 'disabled') n.disabled = !!v;
      else n.setAttribute(k, v);
    }
    for (const c of kids.flat()) {
      if (c === null || c === undefined || c === false) continue;
      n.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return n;
  }

  const store = {
    get(k, d) {
      try {
        const v = localStorage.getItem('rz.' + k);
        return v === null ? d : JSON.parse(v);
      } catch {
        return d;
      }
    },
    set(k, v) {
      localStorage.setItem('rz.' + k, JSON.stringify(v));
    },
  };

  const newId = () =>
    crypto.randomUUID
      ? crypto.randomUUID()
      : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');

  const me = {
    id: store.get('playerId', null) || newId(),
    name: store.get('name', ''),
    skin: store.get('skin', 'plata'),
  };
  store.set('playerId', me.id);

  let config = { skins: [], usingAI: false };
  let current = null; // código de la partida actual
  let state = null;

  const socket = io();

  // ---------- Utilidades de UI ----------
  const skinOf = (id) => config.skins.find((s) => s.id === id) || config.skins[0] || { color: '#eee', accent: '#88a', ink: '#222' };

  function avatar(skinId, name, small) {
    const s = skinOf(skinId);
    return el(
      'div',
      { class: 'avatar' + (small ? ' sm' : ''), style: { background: s.color, borderColor: s.accent, color: s.ink } },
      (name || '?').charAt(0).toUpperCase()
    );
  }

  function renderSkinPicker(container, onPick) {
    container.replaceChildren(
      ...config.skins.map((s) =>
        el(
          'div',
          { class: 'skin' + (me.skin === s.id ? ' selected' : ''), onclick: () => onPick(s.id) },
          avatar(s.id, me.name || '?'),
          s.label
        )
      )
    );
  }

  function requireName() {
    if (!me.name.trim()) {
      alert('Escribe primero tu nombre.');
      $('name').focus();
      return false;
    }
    return true;
  }

  function showMenu() {
    current = null;
    state = null;
    $('screen-game').classList.add('hidden');
    $('screen-menu').classList.remove('hidden');
    history.replaceState(null, '', '/');
    renderMenu();
    loadMyGames();
  }

  function showGame() {
    $('screen-menu').classList.add('hidden');
    $('screen-game').classList.remove('hidden');
    $('recap').classList.add('hidden');
  }

  // ---------- Menú ----------
  function renderMenu() {
    $('name').value = me.name;
    renderSkinPicker($('skins-menu'), (id) => {
      me.skin = id;
      store.set('skin', id);
      renderMenu();
    });
    $('ai-badge').textContent = config.usingAI
      ? 'Narrador con IA activo'
      : 'Narrador local (sin clave de IA: historias de demostración)';
  }

  $('name').addEventListener('input', (e) => {
    me.name = e.target.value.trim();
    store.set('name', me.name);
  });

  async function loadMyGames() {
    const box = $('my-games');
    try {
      const r = await fetch('/api/my-games?playerId=' + encodeURIComponent(me.id));
      const list = await r.json();
      box.replaceChildren();
      if (!list.length) box.append(el('p', { class: 'muted' }, 'Todavía no tienes partidas. ¡Crea una!'));
      for (const g of list) {
        const info = el(
          'div',
          {},
          el('div', {}, el('span', { class: 'code' }, g.code), ' ', g.phase === 'lobby' ? '· en el lobby' : `· escena ${g.turn}`),
          el('div', { class: 'muted small-text' }, g.players.join(', '), g.location ? ' · ' + g.location : '')
        );
        box.append(el('div', { class: 'item' }, info, el('button', { class: 'btn primary small', onclick: () => joinGame(g.code) }, 'Jugar')));
      }
    } catch {
      box.replaceChildren(el('p', { class: 'muted' }, 'No se pudieron cargar tus partidas.'));
    }
  }

  $('btn-create').onclick = async () => {
    if (!requireName()) return;
    const r = await fetch('/api/games', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: me.id, name: me.name, skin: me.skin }),
    });
    const data = await r.json();
    if (!r.ok) return alert(data.error || 'No se pudo crear la partida');
    joinGame(data.code);
  };

  $('btn-join').onclick = () => {
    const code = $('join-code').value.trim().toUpperCase();
    if (!code) return;
    if (!requireName()) return;
    joinGame(code);
  };
  $('join-code').addEventListener('keydown', (e) => e.key === 'Enter' && $('btn-join').click());

  // ---------- Partida ----------
  function joinGame(code, silent = false) {
    socket.emit('game:join', { code, playerId: me.id, name: me.name, skin: me.skin }, (ack) => {
      if (!ack || !ack.ok) {
        if (silent) showMenu();
        if (!silent || (ack && ack.error)) alert((ack && ack.error) || 'Sin conexión con el servidor');
        return;
      }
      current = ack.code;
      store.set('lastCode', current);
      history.replaceState(null, '', '/?code=' + current);
      showGame();
    });
  }

  socket.on('connect', () => {
    $('banner').classList.add('hidden');
    if (current) joinGame(current, true); // reconexión automática
  });
  socket.on('disconnect', () => $('banner').classList.remove('hidden'));

  socket.on('state', (s) => {
    state = s;
    if (current) render();
  });

  socket.on('returned', ({ missed }) => {
    if (!missed || !missed.length) return;
    const box = $('recap-body');
    box.replaceChildren(
      el('p', { class: 'muted small-text' }, 'Mientras no estabas, el grupo siguió. Así llegaste a la escena:'),
      ...missed.map((e) =>
        el(
          'div',
          { class: 'log scene', style: { marginBottom: '8px' } },
          el('p', {}, e.narration),
          el('ul', { class: 'actions' }, e.actions.map((a) => el('li', {}, el('b', {}, a.name + ': '), '“' + a.choice + '”')))
        )
      )
    );
    $('recap').classList.remove('hidden');
  });

  $('btn-recap-close').onclick = () => $('recap').classList.add('hidden');

  let fxTimer = null;
  socket.on('fx', (fx) => {
    if (fx.type === 'rewind') {
      $('fx-text').textContent = fx.text;
      $('fx').classList.remove('hidden');
      clearTimeout(fxTimer);
      fxTimer = setTimeout(() => $('fx').classList.add('hidden'), 4500);
    }
  });
  $('fx').onclick = () => $('fx').classList.add('hidden');

  function choose(index) {
    socket.emit('game:choose', { index }, (ack) => {
      if (ack && !ack.ok) alert(ack.error);
    });
  }

  $('btn-start').onclick = () => {
    socket.emit('game:start', {}, (ack) => {
      if (ack && !ack.ok) alert(ack.error);
    });
  };

  $('btn-leave').onclick = () => {
    socket.emit('game:leave', {}, () => {});
    showMenu();
  };

  $('btn-copy').onclick = () => {
    const url = location.origin + '/?code=' + current;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(url).then(
        () => alert('Enlace copiado:\n' + url),
        () => prompt('Copia el enlace:', url)
      );
    } else {
      prompt('Copia el enlace:', url);
    }
  };

  function renderLog(s) {
    const box = $('log');
    const entries = s.log.slice().reverse();
    box.replaceChildren(
      ...entries.map((e) => {
        if (e.type === 'scene') {
          return el(
            'div',
            { class: 'log scene' },
            el('p', {}, e.narration),
            el('ul', { class: 'actions' }, e.actions.map((a) => el('li', {}, el('b', {}, a.name + ': '), '“' + a.choice + '”')))
          );
        }
        if (e.type === 'rewind') return el('div', { class: 'log rewind' }, '⟳ ', e.text);
        return el('div', { class: 'log system' }, e.text);
      })
    );
    if (!entries.length) box.append(el('p', { class: 'muted' }, 'La crónica aparecerá aquí.'));
  }

  function renderPlayers(s) {
    const box = $('players');
    box.replaceChildren(
      ...s.players.map((p) => {
        let status;
        if (!p.online) status = 'ausente';
        else if (s.phase === 'lobby') status = 'en el lobby';
        else if (s.resolving) status = 'escribiendo…';
        else status = p.chose ? '✔ ha elegido' : 'pensando…';
        return el(
          'div',
          { class: 'pl' + (p.online ? '' : ' off') },
          avatar(p.skin, p.name),
          el(
            'div',
            {},
            el('div', {}, p.name, p.id === me.id ? ' (tú)' : '', p.id === s.hostId ? ' ★' : ''),
            el('div', { class: 'meta' }, el('span', { class: 'dot', style: { background: p.online ? '#44d17a' : '#667' } }), status)
          )
        );
      })
    );
  }

  function render() {
    const s = state;
    const mine = s.players.find((p) => p.id === me.id);
    const isHost = s.hostId === me.id;

    $('g-code').textContent = s.code;
    $('lobby-code').textContent = s.code;
    $('g-turn').textContent =
      (s.phase === 'playing' ? `Escena ${s.turn} · ` : '') + (s.usingAI ? 'Narrador IA' : 'Narrador local');

    // Lobby
    $('lobby').classList.toggle('hidden', s.phase !== 'lobby');
    $('btn-start').classList.toggle('hidden', !isHost);
    $('btn-start').disabled = s.resolving;
    $('lobby-hint').textContent = isHost
      ? `Jugadores conectados: ${s.players.filter((p) => p.online).length} de ${s.maxPlayers}.`
      : 'Esperando a que quien creó la partida empiece la historia.';

    // Escena
    const showScene = s.phase === 'playing' && s.scene;
    $('scene-wrap').classList.toggle('hidden', !showScene);
    if (showScene) {
      $('scene-location').textContent = s.scene.location ? '📍 ' + s.scene.location : '';
      $('scene-text').textContent = s.scene.narration;
      $('writing').classList.toggle('hidden', !s.resolving);

      const canChoose = !s.resolving;
      const opts = $('options');
      opts.replaceChildren(
        ...s.scene.options.map((text, i) =>
          el(
            'button',
            {
              class: 'option' + (s.myChoice === i ? ' chosen' : ''),
              disabled: !canChoose,
              onclick: () => choose(i),
            },
            el('span', { class: 'n' }, i + 1 + '.'),
            text
          )
        )
      );

      const pending = s.players.filter((p) => p.online && !p.chose).map((p) => p.name);
      let waiting = '';
      if (s.resolving) waiting = '';
      else if (s.myChoice === null || s.myChoice === undefined) waiting = 'Elige tu acción.';
      else if (pending.length) waiting = `Has elegido. Esperando a: ${pending.join(', ')}…`;
      else waiting = 'Todos han elegido…';
      $('waiting').textContent = waiting;
    }

    renderPlayers(s);
    renderLog(s);

    // Recuerdos propios
    const mem = $('memories');
    if (mine && mine.memories.length) {
      mem.replaceChildren(
        el('div', { class: 'small-text', style: { color: '#ffb3b3', marginBottom: '6px' } }, 'Recuerdas tus muertes:'),
        el('ul', { class: 'small-text', style: { paddingLeft: '18px', margin: 0 } }, mine.memories.map((m) => el('li', {}, m)))
      );
    } else {
      mem.textContent = 'Aún no has muerto. Qué suerte.';
    }

    // Skins en partida
    renderSkinPicker($('skins-game'), (id) => {
      me.skin = id;
      store.set('skin', id);
      socket.emit('game:skin', { skin: id }, () => {});
      render();
    });

    // Temporizador
    tick();
  }

  function tick() {
    const s = state;
    const t = $('g-timer');
    if (!s || !s.deadline || s.resolving) {
      t.textContent = s && s.resolving ? '' : '';
      return;
    }
    const left = Math.max(0, Math.ceil((s.deadline - Date.now()) / 1000));
    t.textContent = `⏱ ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  }
  setInterval(tick, 500);

  // ---------- Arranque ----------
  async function init() {
    try {
      const r = await fetch('/api/config');
      config = await r.json();
    } catch {
      config = { skins: [], usingAI: false };
    }
    const codeParam = new URLSearchParams(location.search).get('code');
    if (codeParam) $('join-code').value = codeParam.toUpperCase();
    showMenu();
  }
  init();
})();
