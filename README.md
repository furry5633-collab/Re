# Re:Zero · Multijugador

Juego de rol por turnos, multijugador (hasta 3 personas), inspirado en Re:Zero. Un parpadeo y os encontráis en otro mundo. Cada turno, cada jugador elige una de tres acciones; el narrador (IA o local) escribe lo que pasa. Si alguien muere, el mundo vuelve al último punto de guardado, pero el personaje **recuerda** su muerte.

> Es un fan game no oficial. Re:Zero es propiedad de sus autores; el proyecto no es comercial.

## Cómo se juega

1. Escribe tu nombre y elige tu apariencia (skin).
2. **Crear partida** te da un código (ej.: `K7M2Q`). Compártelo con tus amigos o copia la invitación.
3. Quien crea la partida pulsa **Empezar la historia**. Podéis empezar solo con 2 (o solo con 1).
4. Cada escena tiene 3 opciones. Cada jugador elige la suya; cuando todos han elegido (o se acaba el tiempo) el narrador escribe el resultado.
5. **Si te vas**, la historia sigue sin ti y tu personaje queda en pausa. Cuando vuelvas, te aparece un recap de lo que te perdiste y te reúnes con el grupo.
6. **Si alguien muere**, aparece el aviso ⟳ "Regreso por la muerte": el mundo vuelve al último punto de guardado (cada 3 escenas o cuando la IA marca un refugio). Quien murió conserva el recuerdo.
7. **Mis partidas** (en el menú) lista todas las partidas en las que has jugado desde este navegador. Pulsa *Jugar* para volver.

## Ejecutar en tu ordenador

Requisitos: Node.js 18 o superior.

```bash
npm install
npm start        # abre http://localhost:3000
npm test         # pruebas automáticas
```

Variables de entorno opcionales:

| Variable | Para qué sirve | Por defecto |
|---|---|---|
| `LLM_API_KEY` | Clave de la IA (también vale `OPENAI_API_KEY`) | vacío → narrador local |
| `LLM_BASE_URL` | Endpoint compatible con OpenAI | `https://api.openai.com/v1` |
| `LLM_MODEL` | Modelo a usar | `gpt-4o-mini` |
| `TURN_SECONDS` | Tiempo por turno antes de que el destino decida | `120` |
| `DATA_DIR` | Carpeta donde se guardan las partidas | `./data` |
| `PORT` | Puerto del servidor | `3000` |

### Usar la IA

Funciona con cualquier servicio que tenga API compatible con OpenAI. Ejemplos:

- **OpenAI**: `LLM_BASE_URL=https://api.openai.com/v1`, `LLM_MODEL=gpt-4o-mini`
- **Groq** (tiene capa gratuita): `LLM_BASE_URL=https://api.groq.com/openai/v1`, `LLM_MODEL=llama-3.3-70b-versatile`
- **Gemini** (endpoint compatible): `LLM_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/`, `LLM_MODEL=gemini-2.0-flash`

Si la IA falla o devuelve algo inválido, el turno se resuelve con el narrador local: el juego nunca se bloquea.

## Publicarlo en Render

1. Sube esta carpeta a un repositorio de GitHub.
2. En Render: **New → Blueprint**, elige el repositorio. Usará `render.yaml`.
   - O bien **New → Web Service** con: Build `npm install`, Start `npm start`, Health check `/healthz`.
3. En **Environment**, añade `LLM_API_KEY` (opcional).
4. Cuando termine el despliegue, abre la URL `https://tu-app.onrender.com` y comparte la partida con tu amigo.

**Importante sobre guardar las partidas:**
- En el plan **gratis** el disco se borra al reiniciar o redesplegar, así que las partidas se pierden. Además, el servicio se "duerme" tras un rato sin uso y tarda ~1 minuto en volver.
- Para que todo se guarde de verdad, usa un plan de pago con **disco persistente**: en `render.yaml` quita el `#` de las líneas de `DATA_DIR` y `disk`.

## Estructura

```
server/
  index.js    servidor HTTP + Socket.IO (sockets, rutas API)
  game.js     lógica: partidas, turnos, muerte/regreso, reconexión, temporizador
  story.js    narrador: IA (API compatible con OpenAI) o narrador local
  store.js    guardado en data/games.json
  skins.js    apariencias disponibles
public/       interfaz (HTML, CSS y JS sin dependencias)
tests/        pruebas automáticas
```

## Limitaciones conocidas

- No hay cuentas: tu identidad es el navegador. Si borras el almacenamiento del navegador, pierdes el acceso a "Mis partidas" (la partida sigue existiendo y puedes entrar con el código).
- Cualquiera con el código puede unirse (hasta 3 jugadores).
- El narrador local genera historias sencillas de demostración; con IA las historias son mucho más ricas.
- El "reencuentro" resume lo que pasó y reaparece al jugador en el grupo; no es una línea temporal paralela.

## Ideas para seguir

- Skins con imágenes reales y personajes con hojas de personaje (fuerza, astucia, vínculos).
- Un mapa del mundo con lugares que se desbloquean.
- Chat de voz o emotes en la partida.
