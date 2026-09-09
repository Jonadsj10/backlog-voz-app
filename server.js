/**
 * Servidor estático mínimo para "Backlog por voz", solo para conveniencia
 * de desarrollo local (`npm start`).
 *
 * Esta app ya NO tiene backend propio en su flujo real: se deployea en
 * GitHub Pages, que solo sirve archivos estáticos desde `docs/`. La
 * generación de historias llama directo desde el navegador a la Gemini API
 * con la API key que cada persona pega en el panel de configuración
 * (localStorage, ver `docs/index.html`).
 *
 * Este server.js existe únicamente porque abrir `docs/index.html` con
 * doble click (protocolo file://) puede tener comportamiento distinto al de
 * un origen http real en algunos navegadores. Sirviendo la carpeta por HTTP
 * se prueba exactamente lo mismo que va a ver la gente en GitHub Pages.
 * No expone ningún endpoint propio ni maneja secrets: es un `express.static`
 * a secas.
 */

const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.static(path.join(__dirname, 'docs')));

app.listen(PORT, () => {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: 'INFO',
    service: 'backlog-voz-app',
    event: 'server_started',
    data: { port: PORT, staticDir: 'docs/' },
  }));
});
