# restart-frontend

Restart the Vue 3 frontend dev server.

## Usage

When the user asks to restart the frontend, restart the dev server, or restart npm run dev-127, execute the following steps.

## Steps

### 1. Stop existing frontend process

Check if port 7007 is in use:

```bash
netstat -ano | findstr :7007
```

If a process is listening on port 7007 (LISTENING state), kill it:

```bash
taskkill //F //PID <PID>
```

### 2. Start frontend

Launch the frontend from the `ai-video-web/` directory:

```bash
cd ai-video-web && npm run dev-127
```

Run this as a background task (`run_in_background: true`).

### 3. Verify

Wait ~5 seconds, then verify:

```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:7007
```

If it returns `200`, report success. If not, check the background task output for errors.

## Notes

- Frontend runs on port **7007**
- If `node_modules` is missing, run `npm install` first
- Uses `.env.local.127` environment config
- Frontend dev server: http://localhost:7007
- Frontend proxies `/AiVideo` requests to the backend on port 8082
