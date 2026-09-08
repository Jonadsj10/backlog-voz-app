# Backlog por voz

App standalone para dictar (o escribir) una idea, convertirla en historias de usuario con Claude,
y armar un backlog editable con persistencia local y export a Excel.

Reemplaza al prototipo original (Claude Artifact), que solo podía correr dentro del sandbox de
Artifacts: acá el dictado por voz usa el micrófono real del navegador y la API key de Anthropic
vive únicamente en el servidor.

## Instalar

```bash
npm install
```

## Configurar la API key

1. Copiá `.env.example` a `.env`:
   ```bash
   cp .env.example .env
   ```
2. Abrí `.env` y pegá tu API key de Anthropic:
   ```
   ANTHROPIC_API_KEY=sk-ant-...
   PORT=3001
   ```

`.env` está en `.gitignore`: la key nunca se sube al repo ni se sirve al navegador.

## Correr

```bash
npm start
```

Abrí [http://localhost:3001](http://localhost:3001) (o el puerto que hayas puesto en `PORT`).

## Uso

- Tocá el botón del micrófono para dictar tu idea (el navegador va a pedir permiso de micrófono).
  También podés escribirla directamente en el textarea.
- Clickeá "Generar historias" para que Claude arme una o más historias de usuario (título, rol,
  quiero, para qué, criterios de aceptación, story points y prioridad).
- Editá cualquier campo de las tarjetas directamente en el backlog.
- "Exportar a Excel" descarga el backlog completo como `.xlsx`.
- "Vaciar backlog" borra todas las historias (con confirmación).
- El backlog se guarda en el `localStorage` del navegador, entre sesiones.
