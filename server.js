/**
 * Servidor Express para "Backlog por voz".
 *
 * Sirve el frontend estático (public/) y expone POST /api/generate-stories,
 * que llama server-side a la API de Gemini (Google Generative Language API,
 * endpoint `models/{model}:generateContent`) para convertir una idea
 * dictada/escrita en historias de usuario.
 *
 * La API key de Gemini vive únicamente en process.env.GEMINI_API_KEY
 * (cargada desde .env vía dotenv) y nunca se expone al cliente.
 */

require('dotenv').config();

const express = require('express');
const path = require('path');

const app = express();

const PORT = process.env.PORT || 3001;
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
// Alias "siempre vigente" de Google: apunta a la versión estable de Flash
// recomendada del momento, sin que haya que actualizar el nombre del modelo
// a mano cada vez que Google saca una versión nueva. Overrideable por env
// var si en algún momento se quiere pinnear una versión específica.
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';
// Los modelos Gemini 2.5 (flash y pro) gastan tokens de "thinking" (razonamiento interno)
// del mismo presupuesto que maxOutputTokens, ANTES de escribir la respuesta final. Con
// una idea que genera 3+ historias, ese razonamiento + el JSON de salida no entraban en
// el límite viejo (2000) y la respuesta quedaba truncada a mitad del JSON (finishReason
// MAX_TOKENS), de ahí el "No se pudo interpretar la respuesta como JSON válido".
// Subimos el límite para dejar margen a varias historias con criterios de aceptación.
// gemini-2.5-flash soporta hasta ~65536 tokens de salida; 8192 alcanza sobrado para un
// puñado de historias y mantiene la respuesta acotada en costo/latencia.
const MAX_OUTPUT_TOKENS = 8192;
// Fuente: https://ai.google.dev/gemini-api/docs/generate-content/thinking (discovery
// 2026-09-09). Esta app no necesita razonamiento, solo devuelve JSON estructurado, así
// que lo desactivamos vía generationConfig.thinkingConfig.thinkingBudget.
// gemini-2.5-flash acepta thinkingBudget=0 (lo desactiva del todo). gemini-2.5-pro NO lo
// soporta: la API devuelve 400 "The model does not support setting thinking_budget to 0"
// y exige mínimo 128. El default de esta app es gemini-2.5-flash, pero si en el futuro se
// pinnea un modelo "pro" via GEMINI_MODEL, usamos el mínimo que Pro sí acepta (128) para
// no romper la llamada.
const THINKING_BUDGET = /-pro/i.test(GEMINI_MODEL) ? 128 : 0;

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
 * Mismo system prompt que usaba el prototipo (Claude Artifact), ahora enviado
 * como `system_instruction` de Gemini en vez de ir pegado al mensaje de
 * usuario (Gemini sí soporta ese campo separado del contents).
 *
 * @returns {string} Instrucciones fijas de rol y formato de salida.
 */
function buildSystemInstruction() {
  return `Sos un Product Owner experto en metodologias agiles (Scrum/Kanban) que arma historias de usuario a partir de ideas dictadas por voz por un lider de equipo.

Tarea: leer la idea y convertirla en una o mas historias de usuario completas.

Reglas:
- Si la idea combina mas de una funcionalidad o necesidad distinta, separala en historias de usuario independientes.
- Cada historia debe tener: titulo corto (maximo 8 palabras), rol (quien necesita la funcionalidad, ej "usuario del equipo de ventas"), la funcionalidad deseada en pocas palabras, el beneficio o motivo, entre 2 y 5 criterios de aceptacion concretos y verificables, una estimacion en story points (Fibonacci: 1, 2, 3, 5, 8, 13, 21) y una prioridad (Alta, Media o Baja) segun el impacto que se desprende de la idea.
- Los criterios de aceptacion son oraciones cortas y verificables, no un parrafo.
- Respondes UNICAMENTE con JSON valido (sin texto adicional, sin markdown, sin bloques de codigo), con este formato exacto:
[{"titulo":"...", "rol":"...", "quiero":"...", "paraQue":"...", "criterios":["...","..."], "puntos":5, "prioridad":"Media"}]`;
}

/**
 * Arma el contenido de usuario (la idea dictada/escrita) que va en `contents`.
 *
 * @param {string} ideaText - Idea del usuario, ya validada como string no vacío.
 * @returns {string} Texto a enviar como mensaje de usuario.
 */
function buildUserContent(ideaText) {
  return `Idea del usuario:\n${ideaText}`;
}

/**
 * Extrae el texto de la respuesta de Gemini (generateContent) y le saca
 * fences de markdown (```json ... ```) si vinieran, antes de parsearlo.
 *
 * @param {object} geminiBody - Body JSON ya parseado de la respuesta de Gemini.
 * @returns {{text: string, finishReason: string|null}} Texto plano listo para
 *   JSON.parse, junto con el finishReason del candidato (por ejemplo 'STOP' o
 *   'MAX_TOKENS'), para que el caller pueda distinguir una respuesta completa
 *   de una truncada por límite de tokens antes de intentar parsearla.
 * @throws {Error} Si la respuesta no trae candidatos o contenido de tipo texto
 *   (por ejemplo, si el prompt fue bloqueado por los filtros de seguridad).
 */
function extractText(geminiBody) {
  const candidate = Array.isArray(geminiBody.candidates) ? geminiBody.candidates[0] : null;

  if (!candidate) {
    const blockReason = geminiBody.promptFeedback && geminiBody.promptFeedback.blockReason;
    throw new Error(
      blockReason
        ? `Gemini bloqueó la solicitud (motivo: ${blockReason}).`
        : 'La respuesta de Gemini no trajo candidatos.'
    );
  }

  const finishReason = candidate.finishReason || null;
  const parts = candidate.content && Array.isArray(candidate.content.parts) ? candidate.content.parts : [];
  const block = parts.find((p) => typeof p.text === 'string');
  if (!block) {
    throw new Error(
      `La respuesta de Gemini no trajo contenido de texto (finishReason: ${finishReason || 'desconocido'}).`
    );
  }

  let text = block.text.trim();
  // Saca fences de markdown tipo ```json ... ``` o ``` ... ``` si vinieran.
  if (text.startsWith('```')) {
    text = text.replace(/^```[a-zA-Z]*\n?/, '').replace(/```$/, '').trim();
  }
  return { text, finishReason };
}

/**
 * Llama a la Gemini API (Generative Language API) server-side, endpoint
 * `models/{model}:generateContent`, para generar historias de usuario a
 * partir de una idea.
 *
 * @param {string} ideaText - Idea validada del usuario.
 * @returns {Promise<Array<object>>} Array de historias de usuario.
 * @throws {Error} Con `.statusCode` y `.code` seteados para que el handler
 *   HTTP arme la respuesta de error estándar.
 */
async function generateStoriesFromIdea(ideaText) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    const err = new Error(
      'Falta configurar GEMINI_API_KEY en el servidor. Copiá .env.example a .env y pegá tu API key de Google AI Studio.'
    );
    err.statusCode = 500;
    err.code = 'CONFIGURATION_ERROR';
    throw err;
  }

  const url = `${GEMINI_API_BASE}/models/${GEMINI_MODEL}:generateContent`;

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: buildSystemInstruction() }] },
        contents: [{ role: 'user', parts: [{ text: buildUserContent(ideaText) }] }],
        generationConfig: {
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          responseMimeType: 'application/json',
          thinkingConfig: { thinkingBudget: THINKING_BUDGET },
        },
      }),
    });
  } catch (networkErr) {
    log('ERROR', 'gemini_network_error', { message: networkErr.message });
    const err = new Error('No se pudo conectar con la API de Gemini. Probá de nuevo en un momento.');
    err.statusCode = 502;
    err.code = 'UPSTREAM_ERROR';
    throw err;
  }

  if (!response.ok) {
    let upstreamMessage = `Gemini respondió con status ${response.status}.`;
    try {
      const errBody = await response.json();
      if (errBody && errBody.error && errBody.error.message) {
        upstreamMessage = errBody.error.message;
      }
    } catch (_parseErr) {
      // el body de error no era JSON, seguimos con el mensaje genérico
    }
    log('ERROR', 'gemini_api_error', { status: response.status });
    const err = new Error('La API de Gemini devolvió un error: ' + upstreamMessage);
    err.statusCode = 502;
    err.code = 'UPSTREAM_ERROR';
    throw err;
  }

  const geminiBody = await response.json();

  let text;
  let finishReason;
  try {
    const extracted = extractText(geminiBody);
    text = extracted.text;
    finishReason = extracted.finishReason;
  } catch (extractErr) {
    log('ERROR', 'gemini_response_shape_error', { message: extractErr.message });
    const err = new Error('La respuesta de Gemini no tuvo el formato esperado: ' + extractErr.message);
    err.statusCode = 502;
    err.code = 'UPSTREAM_PARSE_ERROR';
    throw err;
  }

  // Si Gemini cortó la respuesta por exceder maxOutputTokens, el texto queda con el JSON
  // a medio escribir. Lo chequeamos ANTES de intentar JSON.parse: si no, el usuario final
  // solo ve el mensaje genérico de "JSON inválido", que no explica qué pasó ni cómo
  // evitarlo (idea más corta o dividida en varios pedidos).
  if (finishReason === 'MAX_TOKENS') {
    log('ERROR', 'gemini_response_truncated', { finishReason, maxOutputTokens: MAX_OUTPUT_TOKENS });
    const err = new Error(
      'La respuesta de Gemini se cortó por exceder el límite de tokens. Probá con una idea más corta o separá las historias en varios pedidos.'
    );
    err.statusCode = 502;
    err.code = 'UPSTREAM_TRUNCATED';
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
    model: GEMINI_MODEL,
    apiKeyConfigured: Boolean(process.env.GEMINI_API_KEY),
  });
});
