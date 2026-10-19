# restart-backend

Restart the Spring Boot backend service.

## Usage

When the user asks to restart the backend, rebuild the backend, or restart the Spring Boot server, execute the following steps.

## Steps

### 1. Stop existing backend process

Check if port 8082 is in use:

```bash
netstat -ano | findstr :8082
```

If a process is listening on port 8082, kill it:

```bash
taskkill //F //PID <PID>
```

If `taskkill` fails, try the Maven shutdown approach or ask the user to help.

### 2. Start backend

Launch the backend from the `ai-video/` directory:

```bash
cd ai-video && mvn spring-boot:run
```

Run this as a background task (`run_in_background: true`).

### 3. Verify

Wait ~15 seconds, then verify:

```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:8082/doc.html
```

If it returns `200`, report success. If not, check the background task output for errors.

## Notes

- Backend runs on port **8082**
- Java 17 required (`C:/kzuo/tools_dev/java_jdk17/installed`)
- If the build fails, run `mvn clean compile` first
- API docs available at: http://localhost:8082/doc.html
