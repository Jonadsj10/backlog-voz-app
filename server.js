/**
 * Servidor Express para "Backlog por voz".
 *
 * Sirve el frontend estático (public/) y expone POST /api/generate-stories,
 * que llama server-side a la API de Claude (Anthropic Messages API) para
 * convertir una idea dictada/escrita en historias de usuario.
 *
 * La API key de Anthropic vive únicamente en process.env.ANTHROPIC_API_KEY
 * (cargada desde .env vía dotenv) y nunca se expone al cliente.
 */

require('dotenv').config();

const express = require('express');
const path = require('path');

const app = express();

const PORT = process.env.PORT || 3001;
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_MODEL = 'claude-sonnet-5';
const MAX_TOKENS = 2000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/**
 * Construye una respuesta de error con el schema estándar Strata.
 *
 * @param {string} code - Código de error en snake_case mayúsculas.
 * @param {string} message - Mensaje legible para el humano.
 * @param {object} [details] - Info adicional opcional para debugging.
 * @returns {{error: {code: string, message: string, details?: object}}}
 */
function buildErrorBody(code, message, details) {
  const error = { code, message };
  if (details) {
    error.details = details;
  }
  return { error };
}

/**
 * Loggea un evento estructurado en JSON a stdout.
 *
 * Nunca incluye valores de secrets: si hace falta indicar si una key está
 * presente, se loguea como booleano, jamás el valor.
 *
 * @param {string} level - INFO | WARN | ERROR
 * @param {string} event - Nombre corto del evento.
 * @param {object} [data] - Payload relevante, sin PII ni credentials.
 */
function log(level, event, data) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    service: 'backlog-voz-app',
    event,
    data: data || {},
  };
  console.log(JSON.stringify(entry));
}

/**
 * Mismo system prompt que usaba el prototipo (Claude Artifact), adaptado
 * para pedirle a Claude que arme historias de usuario a partir de una idea.
 *
 * @param {string} ideaText - Idea del usuario, ya validada como string no vacío.
 * @returns {string} Prompt completo a enviar como mensaje de usuario.
 */
function buildPrompt(ideaText) {
  return `Sos un Product Owner experto en metodologias agiles (Scrum/Kanban) que arma historias de usuario a partir de ideas dictadas por voz por un lider de equipo.

Tarea: leer la idea y convertirla en una o mas historias de usuario completas.

Reglas:
- Si la idea combina mas de una funcionalidad o necesidad distinta, separala en historias de usuario independientes.
- Cada historia debe tener: titulo corto (maximo 8 palabras), rol (quien necesita la funcionalidad, ej "usuario del equipo de ventas"), la funcionalidad deseada en pocas palabras, el beneficio o motivo, entre 2 y 5 criterios de aceptacion concretos y verificables, una estimacion en story points (Fibonacci: 1, 2, 3, 5, 8, 13, 21) y una prioridad (Alta, Media o Baja) segun el impacto que se desprende de la idea.
- Los criterios de aceptacion son oraciones cortas y verificables, no un parrafo.
- Respondes UNICAMENTE con JSON valido (sin texto adicional, sin markdown, sin bloques de codigo), con este formato exacto:
[{"titulo":"...", "rol":"...", "quiero":"...", "paraQue":"...", "criterios":["...","..."], "puntos":5, "prioridad":"Media"}]

Idea del usuario:
${ideaText}`;
}

/**
 * Extrae el texto de la respuesta de la Anthropic Messages API y le saca
 * fences de markdown (```json ... ```) si vinieran, antes de parsearlo.
 *
 * @param {object} anthropicBody - Body JSON ya parseado de la respuesta de Anthropic.
 * @returns {string} Texto plano, listo para JSON.parse.
 * @throws {Error} Si la respuesta no trae contenido de tipo texto.
 */
function extractText(anthropicBody) {
  const block = Array.isArray(anthropicBody.content)
    ? anthropicBody.content.find((c) => c.type === 'text')
    : null;
  if (!block || typeof block.text !== 'string') {
    throw new Error('La respuesta de Anthropic no trajo contenido de texto.');
  }
  let text = block.text.trim();
  // Saca fences de markdown tipo ```json ... ``` o ``` ... ``` si vinieran.
  if (text.startsWith('```')) {
    text = text.replace(/^```[a-zA-Z]*\n?/, '').replace(/```$/, '').trim();
  }
  return text;
}

/**
 * Llama a la Anthropic Messages API server-side para generar historias
 * de usuario a partir de una idea.
 *
 * @param {string} ideaText - Idea validada del usuario.
 * @returns {Promise<Array<object>>} Array de historias de usuario.
 * @throws {Error} Con `.statusCode` y `.code` seteados para que el handler
 *   HTTP arme la respuesta de error estándar.
 */
async function generateStoriesFromIdea(ideaText) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    const err = new Error(
      'Falta configurar ANTHROPIC_API_KEY en el servidor. Copiá .env.example a .env y pegá tu API key.'
    );
    err.statusCode = 500;
    err.code = 'CONFIGURATION_ERROR';
    throw err;
  }

  let response;
  try {
    response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: MAX_TOKENS,
        messages: [{ role: 'user', content: buildPrompt(ideaText) }],
      }),
    });
  } catch (networkErr) {
    log('ERROR', 'anthropic_network_error', { message: networkErr.message });
    const err = new Error('No se pudo conectar con la API de Anthropic. Probá de nuevo en un momento.');
    err.statusCode = 502;
    err.code = 'UPSTREAM_ERROR';
    throw err;
  }

  if (!response.ok) {
    let upstreamMessage = `Anthropic respondió con status ${response.status}.`;
    try {
      const errBody = await response.json();
      if (errBody && errBody.error && errBody.error.message) {
        upstreamMessage = errBody.error.message;
      }
    } catch (_parseErr) {
      // el body de error no era JSON, seguimos con el mensaje genérico
    }
    log('ERROR', 'anthropic_api_error', { status: response.status });
    const err = new Error('La API de Anthropic devolvió un error: ' + upstreamMessage);
    err.statusCode = response.status === 401 ? 502 : 502;
    err.code = 'UPSTREAM_ERROR';
    throw err;
  }

  const anthropicBody = await response.json();

  let text;
  try {
    text = extractText(anthropicBody);
  } catch (extractErr) {
    log('ERROR', 'anthropic_response_shape_error', { message: extractErr.message });
    const err = new Error('La respuesta de Anthropic no tuvo el formato esperado.');
    err.statusCode = 502;
    err.code = 'UPSTREAM_PARSE_ERROR';
    throw err;
  }

  let stories;
  try {
    stories = JSON.parse(text);
  } catch (jsonErr) {
    log('ERROR', 'stories_json_parse_error', { message: jsonErr.message });
    const err = new Error('No se pudo interpretar la respuesta como JSON válido. Probá reformular la idea.');
    err.statusCode = 502;
    err.code = 'UPSTREAM_PARSE_ERROR';
    throw err;
  }

  if (!Array.isArray(stories)) {
    const err = new Error('La respuesta no fue un array de historias.');
    err.statusCode = 502;
    err.code = 'UPSTREAM_PARSE_ERROR';
    throw err;
  }

  return stories;
}

app.post('/api/generate-stories', async (req, res) => {
  const idea = req.body && req.body.idea;

  if (typeof idea !== 'string' || idea.trim().length === 0) {
    log('WARN', 'validation_error', { field: 'idea' });
    return res.status(400).json(
      buildErrorBody('VALIDATION_ERROR', "El campo 'idea' es requerido y no puede estar vacío.", {
        field: 'idea',
        constraint: 'required',
      })
    );
  }

  log('INFO', 'generate_stories_requested', { ideaLength: idea.length });

  try {
    const stories = await generateStoriesFromIdea(idea.trim());
    log('INFO', 'generate_stories_succeeded', { storyCount: stories.length });
    return res.status(200).json(stories);
  } catch (err) {
    const statusCode = err.statusCode || 500;
    const code = err.code || 'INTERNAL_ERROR';
    // Nunca se devuelve el stack trace al cliente, solo el mensaje curado.
    return res.status(statusCode).json(buildErrorBody(code, err.message));
  }
});

app.listen(PORT, () => {
  log('INFO', 'server_started', {
    port: PORT,
    apiKeyConfigured: Boolean(process.env.ANTHROPIC_API_KEY),
  });
});
