# Sprich – Sprachlern-App

React-Frontend + FastAPI-Backend (Anthropic-Proxy) für eine
Sprachlern-App mit Streaming, Voice-Input, TTS, Vokabelheft
und Shadowing-Modus.

Der API-Key liegt nur serverseitig im Backend und wird nie
ans Frontend ausgeliefert.

## Architektur

```
Browser ──→ nginx (frontend) ──→ FastAPI (backend) ──→ api.anthropic.com
              │  serviert React-Build
              └─ /api/* proxied zum Backend (SSE-fähig)
```

## Lokal entwickeln

```bash
# Backend
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
ANTHROPIC_API_KEY=sk-ant-... uvicorn main:app --reload --port 8000

# Frontend (in zweitem Terminal)
cd frontend
npm install
npm run dev
# → http://localhost:5173 (proxied /api → localhost:8000)
```

## Mit Docker-Compose lokal

```bash
cp .env.example .env
# .env editieren: ANTHROPIC_API_KEY eintragen
docker compose up --build
# → http://localhost:3000
```

## Deployment auf Coolify

1. **Repository in Coolify anlegen**
   - GitHub/GitLab/Gitea-Repo verbinden, oder als "Public Git Repository"
   - Build-Pack: **Docker Compose**
   - Compose-Datei: `docker-compose.yml`

2. **Environment-Variablen setzen** (in Coolify-UI)
   - `ANTHROPIC_API_KEY` = dein Key
   - `ALLOWED_ORIGINS` = `https://sprich.deinedomain.at` (deine endgültige URL)

3. **Domain konfigurieren**
   - Coolify routet auf den `frontend`-Service Port 80
   - Subdomain z. B. `sprich.deinedomain.at` zuweisen
   - Auto-SSL via Traefik aktivieren (Default in Coolify)

4. **Deploy → Logs prüfen**
   - Backend sollte auf Port 8000 lauschen
   - Frontend serviert über Nginx, /api/* wird zum Backend proxied

## Am Handy installieren (PWA)

1. App in Safari (iOS) oder Chrome (Android) öffnen
2. Teilen-Menü → "Zum Home-Bildschirm hinzufügen"
3. Beim ersten Mikro-Klick: Browser fragt nach Mikrofon-Berechtigung → erlauben
4. Voice-Input, TTS, Shadowing und Vokabelheft funktionieren jetzt vollständig

## Sicherheit

- API-Key ausschließlich serverseitig (Env-Variable im Backend-Container)
- Backend lehnt unerlaubte Origins ab (via `ALLOWED_ORIGINS`)
- Optional erweiterbar um Rate-Limiting (z. B. `slowapi`) und Auth
- Vokabel-Daten liegen im Browser-`localStorage`, nicht serverseitig

## Modell wechseln

Im Frontend `src/App.jsx`:

```js
const MODEL = "claude-sonnet-4-20250514";
```

auf das gewünschte Modell ändern und neu bauen.

## Struktur

```
.
├── backend/
│   ├── main.py              FastAPI-Proxy
│   ├── requirements.txt
│   └── Dockerfile
├── frontend/
│   ├── src/
│   │   ├── App.jsx          Hauptkomponente
│   │   ├── main.jsx
│   │   └── index.css
│   ├── index.html
│   ├── package.json
│   ├── vite.config.js
│   ├── tailwind.config.js
│   ├── postcss.config.js
│   ├── nginx.conf
│   └── Dockerfile
├── docker-compose.yml
├── .env.example
└── README.md
```

## Was ist drin

- Streaming-Chat mit Claude in Zielsprache, niveau-adaptiv
- Voice-Input (Web Speech API, im echten Browser)
- TTS für jede Nachricht inkl. Auto-Vorlesen
- Klickbare Wörter mit Übersetzung, Beispielsatz und Vokabel-Sammler
- Vokabelheft, persistent im Browser
- Shadowing-Modus mit Wort-für-Wort-Bewertung und Score
- Übersetzung jeder Antwort auf Deutsch
- Acht Sprachen, fünf Niveaustufen, optionales Thema
