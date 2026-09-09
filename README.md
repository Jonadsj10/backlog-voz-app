# Backlog por voz

App para dictar (o escribir) una idea, convertirla en historias de usuario con Gemini, y armar
un backlog editable con persistencia local y export a Excel.

Se distribuye como un sitio estático publicado en GitHub Pages. No hay que instalar nada para
usarla: se abre el link y listo.

## Cómo se usa (para cualquiera del equipo)

1. Abrí el link de GitHub Pages que te compartieron.
2. La primera vez, clickeá **"Configurar API key"** (arriba a la derecha) y pegá tu propia API
   key de Gemini. Si no tenés una, el mismo panel tiene un link a
   [Google AI Studio](https://aistudio.google.com/apikey) para sacar una gratis (necesitás una
   cuenta de Google).
3. Tocá el botón del micrófono para dictar tu idea (el navegador va a pedir permiso de
   micrófono), o escribila directamente en el cuadro de texto.
4. Clickeá **"Generar historias"** para que Gemini arme una o más historias de usuario (título,
   rol, quiero, para qué, criterios de aceptación, story points y prioridad).
5. Editá cualquier campo de las tarjetas directamente en el backlog.
6. **"Exportar a Excel"** descarga el backlog completo como `.xlsx`.
7. **"Vaciar backlog"** borra todas las historias (con confirmación).

### Dónde vive tu API key

Tu key se guarda **solo en el navegador de tu dispositivo** (localStorage), nunca en un
servidor. Cada persona que abre el link pega la suya: nadie comparte ni ve la key de otro. Si
cambiás de navegador o de compu, tenés que pegarla de nuevo ahí. El backlog (las historias que
ya generaste) también vive solo en tu navegador, así que no se comparte automáticamente entre
compañeros ni entre dispositivos: usá "Exportar a Excel" para compartir lo que armaste.

Nota de seguridad honesta: localStorage no está encriptado. No es un lugar más seguro que
cualquier otro dato local del navegador, pero la key nunca sale de tu dispositivo ni pasa por
ningún servidor de Strata ni de terceros (más que el propio Gemini, al que le pegás directo).

## Arquitectura (por qué cambió)

Hasta la versión anterior, esta app tenía un backend propio (Express) que guardaba una única
`GEMINI_API_KEY` en el servidor y hacía de proxy hacia Gemini. Para poder compartir la app por un
link simple sin correr infraestructura propia, se migró a **GitHub Pages**, que solo puede servir
archivos estáticos (HTML/CSS/JS), no puede correr Node/Express.

Eso significa que la generación de historias **ya no pasa por ningún backend**: el navegador de
cada persona llama directo a la Gemini API (`generativelanguage.googleapis.com`) con su propia
API key. Se confirmó con un test real de navegador que esa API acepta llamadas `fetch` directas
desde un origen arbitrario (CORS permisivo), así que no hace falta ningún proxy intermedio.

- **Punto de entrada para GitHub Pages:** `docs/index.html` (activá GitHub Pages en
  Settings → Pages → Branch `main` / `master`, carpeta `/docs`).
- **`server.js`:** ya no hace de proxy a Gemini. Quedó como una conveniencia opcional 100%
  local: un `express.static` que sirve `docs/` por HTTP, útil para probar la app tal cual la va
  a ver la gente en GitHub Pages (en vez de abrir el HTML con doble click, que en algunos
  navegadores se comporta distinto por ser protocolo `file://`).

## Desarrollo local

No es necesario para usar la app (ver arriba), esto es solo para quien la vaya a modificar.

**Opción A: abrir el archivo directo**

Abrí `docs/index.html` con doble click o arrastrándolo al navegador. Funciona para casi todo;
la única salvedad es que algunos navegadores tratan el protocolo `file://` distinto a un origen
`http` real para ciertas políticas de seguridad.

**Opción B: server estático local (recomendado, calca GitHub Pages)**

```bash
npm install
npm start
```

Abrí [http://localhost:3001](http://localhost:3001) (o el puerto que hayas puesto en la variable
de entorno `PORT`).

## Lo que no cambió

Diseño visual, edición de tarjetas, export a Excel, dictado por voz (Web Speech API) y
persistencia del backlog en `localStorage`: todo eso es independiente de la API key y sigue
funcionando igual que antes.
