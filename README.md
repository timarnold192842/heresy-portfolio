# Heresy Portfolio (Hosted + Persistent)

This repo hosts your Heresy trade dashboard and stores portfolio state on the server so it is shared across browsers/devices.

## What changed

- Frontend still keeps a local copy in browser storage for offline/fallback.
- Frontend now also syncs every save to `PUT /api/state`.
- On load, frontend prefers server state from `GET /api/state`.
- If server is empty, existing local state is pushed up automatically.

## Local run

1. Install dependencies:

```bash
npm install
```

2. Start server:

```bash
npm start
```

3. Open:

- `http://localhost:3000`

## Data persistence

State is written to:

- `data/state.json`

Back this file with persistent disk on your host.

## Optional write protection

Set an environment variable on the server:

- `APP_WRITE_TOKEN=your_secret_token`

When enabled, writes require the `x-write-token` header. You can set this in browser local storage on your own machine:

```js
localStorage.setItem('heresy_write_token', 'your_secret_token')
```

## Deploy to Render (recommended simple path)

1. Create a new GitHub repo and push this folder.
2. In Render, create a new **Web Service** from the repo.
3. Build command: `npm install`
4. Start command: `npm start`
5. Add a persistent disk mounted at:
   - `/opt/render/project/src/data`
6. Set environment variables:
   - `PORT=10000` (Render default is fine)
   - Optional: `APP_WRITE_TOKEN=...`

Because the app and API are on the same service, no CORS setup is needed.

## Create and push GitHub repo

Run these commands from this folder:

```bash
git init
git add .
git commit -m "Initial hosted Heresy portfolio with persistent storage"
git branch -M main
git remote add origin https://github.com/<your-username>/heresy-portfolio.git
git push -u origin main
```

## Notes

- `public/heresy.html` and `public/heresy-trades.js` are copied from your existing workspace version.
- Existing import/export JSON still works.
