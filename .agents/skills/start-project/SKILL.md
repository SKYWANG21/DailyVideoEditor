# start-project

Start the AI Video project (backend + frontend) for local development.

## Usage

When the user asks to start the project, launch the app, or run the dev server, execute the following steps:

## Steps

### 1. Check if services are already running

Check if port 8082 (backend) and 7007 (frontend) are already in use:

```bash
netstat -ano | findstr :8082
netstat -ano | findstr :7007
```

If either port is already listening, inform the user and skip starting that service.

### 2. Start Backend (Spring Boot)

Launch the backend in the background from the `ai-video/` directory:

```bash
cd ai-video && mvn spring-boot:run
```

Run this as a background task (`run_in_background: true`).

### 3. Start Frontend (Vue 3)

Once the backend is starting, launch the frontend from the `ai-video-web/` directory:

```bash
cd ai-video-web && npm run dev-127
```

Run this as a background task (`run_in_background: true`).

### 4. Wait and verify

After both services are launched, wait a few seconds then verify:

```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:8082
curl -s -o /dev/null -w "%{http_code}" http://localhost:7007
```

- Backend docs: http://localhost:8082/doc.html
- Frontend: http://localhost:7007

Report the status of both services to the user.

## Notes

- Backend runs on port **8082** (Spring Boot)
- Frontend runs on port **7007** (Vite dev server)
- Frontend proxies `/AiVideo` requests to the backend automatically
- If `node_modules` is missing in `ai-video-web/`, run `npm install` first
- If backend fails to compile, run `mvn clean compile` first
