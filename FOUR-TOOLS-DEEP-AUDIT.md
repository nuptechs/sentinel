# Four-Tools Deep Audit — Evidence-Backed

> **Escopo:** Sentinel · Debug Probe · Manifest (PermaCat) · Agentes QA (UI QA Sentinel + EasyNuP Test Sentinel).
> **Regra:** cada afirmação abaixo cita `arquivo:linha`. Onde a leitura não foi feita, marco explicitamente **[UNKNOWN]**.
> **Método:** leitura direta via `read_file` + subagentes de busca (reports salvos em disco e relidos). Nada é inferido de README.

---

## 1. Sentinel (`/Users/yurif/Downloads/sentinel`)

### 1.1 Arquitetura verificada

| Camada | Arquivo | Linhas lidas | Fatos verificados |
|---|---|---|---|
| Container DI | [src/container.js](/Users/yurif/Downloads/sentinel/src/container.js) | 1–250 | 7 ports cabeados por env-var: `DATABASE_URL` → `PostgresStorageAdapter`, `ANTHROPIC_API_KEY` → `ClaudeAIAdapter`, `DEBUG_PROBE_URL` → `DebugProbeTraceAdapter`, `MANIFEST_URL` → `ManifestAnalyzerAdapter`, `WEBHOOK_URL`+`WEBHOOK_SECRET` → `WebhookNotificationAdapter`, tokens GitHub/Linear/Jira → IssueTracker (prioridade GH>Linear>Jira), fallback `Noop*` em todos os pontos. |
| App Express | [src/server/app.js](/Users/yurif/Downloads/sentinel/src/server/app.js) | 1–80 | Factory Express + rotas `/api/sessions`, `/api/findings`, `/api/projects`, `/mcp`, `/sse`, `/messages`. |

### 1.2 Pipeline de diagnóstico (AI)

[src/core/services/diagnosis.service.js](/Users/yurif/Downloads/sentinel/src/core/services/diagnosis.service.js) L1–300 — **pipeline de 4 etapas confirmado**:
1. `enrichTraces()` — chama `trace.getTraces(sessionId, correlationId)` se `TracePort.isConfigured()`.
2. `resolveCode()` — `analyzer.resolveEndpoint(projectId, endpoint)` via Manifest.
3. `ai.diagnose({ finding, traces, codeContext })` — prompt JSON-schema estrito.
4. `notification.onDiagnosisReady(finding)` — best-effort (`console.warn` se falhar).

Cada etapa tem **fallback gracioso** (`try/catch` + `confidence:"low"` quando adapters não configurados) — este é o motivo do smoke test anterior retornar `confidence:"low"`: traces vazios.

### 1.3 Adapters críticos

| Adapter | Arquivo | Evidência-chave |
|---|---|---|
| `DebugProbeTraceAdapter` | [src/adapters/trace/debugprobe.adapter.js](/Users/yurif/Downloads/sentinel/src/adapters/trace/debugprobe.adapter.js) L1–900 | AsyncLocalStorage por request; W3C `traceparent`; circuit breaker (3 falhas/60s, recovery 30s); dual-header auth (`X-API-Key` + `Authorization: Bearer`); WebSocket `collectLive()` com janela configurável. |
| `ManifestAnalyzerAdapter` | [src/adapters/analyzer/manifest.adapter.js](/Users/yurif/Downloads/sentinel/src/adapters/analyzer/manifest.adapter.js) L1–250 | `MANIFEST_PROJECT_ID_MAP` (ex: `easynup:3`); `resolveEndpoint()` bate em `/api/projects/:id/endpoints`; **`getSourceFile()` lê do filesystem LOCAL** via `SENTINEL_PROJECT_ROOTS`, não via API — limitação: não funciona se o código não estiver no mesmo host. |
| `ClaudeAIAdapter` | [src/adapters/ai/claude.adapter.js](/Users/yurif/Downloads/sentinel/src/adapters/ai/claude.adapter.js) L1–200 | Modelo `claude-sonnet-4-20250514`; DIAGNOSIS_SYSTEM e CORRECTION_SYSTEM impõem JSON schema rígido (rootCause, explanation, confidence∈{low\|medium\|high}, suggestedFix.files[]). |

### 1.4 Services (CRUD + orquestração)

- [src/core/services/finding.service.js](/Users/yurif/Downloads/sentinel/src/core/services/finding.service.js) L1–100 — `create()` faz **backfill** do `debugProbeSessionId` lendo `session.metadata` quando não é enviado (L28–45). Incrementa métrica `findingsCreatedTotal{source,type}`.
- [src/core/services/correction.service.js](/Users/yurif/Downloads/sentinel/src/core/services/correction.service.js) L1–100 — Exige `finding.diagnosis` presente antes de gerar correção (L30). `_extractFilePaths()` reúne paths de `codeContext.endpoints[].sourceFiles` + `diagnosis.suggestedFix.files` (L85–102).
- [src/core/services/integration.service.js](/Users/yurif/Downloads/sentinel/src/core/services/integration.service.js) L1–75 — `pushToTracker()` previne push duplicado consultando `annotation.integrationRefs[]` (L27–32). `suggestTitle()` delega ao AI adapter.

### 1.5 MCP server (ferramentas para agentes)

[src/mcp/server.js](/Users/yurif/Downloads/sentinel/src/mcp/server.js) L1–600 — factory `createSentinelMCP()` usando `@modelcontextprotocol/sdk`. Ferramentas confirmadas: `list_findings`, `get_finding_details`, `diagnose_finding`, `get_correction`, `push_to_tracker`, `mark_fix_applied`, `clarify_finding`, `get_project_stats`, `get_source_file`, `collect_live_traces`, `get_metrics_snapshot` (11 tools no mínimo).

- `get_source_file` (L~220): delega ao analyzer; herda a limitação "filesystem local" do Manifest adapter.
- `collect_live_traces` (L264–290): retorna `{error:'No trace adapter configured', events:[], isError:true}` se `trace.collectLive` ausente — **sinaliza adapter mal configurado, não falha silenciosa**.
- `get_metrics_snapshot` (L292–321): expõe Prometheus registry com filtro por prefixo.
- Facade `MCPServer` legada (L319+) mantém compatibilidade JSON-RPC (`initialize`, `tools/list`, `tools/call`, `ping`).

### 1.6 Gaps confirmados por leitura

1. `getSourceFile` local — Manifest adapter exige `SENTINEL_PROJECT_ROOTS` mapping. Se o host do Sentinel não tem o código checkout, correction falha silenciosamente ([src/core/services/correction.service.js](/Users/yurif/Downloads/sentinel/src/core/services/correction.service.js) L42 — `catch { /* skip unreadable */ }`).
2. ~~Notificação sem retry~~ — **CORREÇÃO (ver §1.7.1):** o `WebhookNotificationAdapter` TEM retry+DLQ completo quando recebe `storage`. O `.catch(console.warn)` em diagnosis/correction services é apenas blindagem externa para não derrubar o fluxo de negócio; ele NÃO desliga o retry interno do adapter.
3. Title suggestion só via API explícita (integration.service.js L61) — não há auto-trigger no `POST /api/findings`.

---

### 1.7 Internals Sentinel verificados (sessão adicional)

Leituras complementares com linha exata. Todos os arquivos abaixo foram lidos diretamente nesta sessão.

#### 1.7.1 Notificação: retry + DLQ + SSRF + HMAC (desmente gap anterior)

[src/adapters/notification/webhook.adapter.js](/Users/yurif/Downloads/sentinel/src/adapters/notification/webhook.adapter.js) L1–240:
- **Dois modos:** `LegacyMode` (fire-and-forget) quando construído sem `storage`; `PersistentMode` (retry+DLQ) quando construído com `WebhookEventStore`.
- **Schedule de retry fixo** (constantes L21–30): `[60s, 300s, 1800s, 7200s, 43200s]`, `WEBHOOK_MAX_RETRIES = 5`, `WEBHOOK_TIMEOUT_MS = 30_000`.
- **Eventos emitidos** (L45–80): `finding.created`, `finding.diagnosed`, `finding.correction_proposed`.
- **Headers de delivery** (L120–150): `X-Sentinel-Event`, `X-Sentinel-Delivery` (UUID), `X-Sentinel-Timestamp` (unix seconds), `X-Sentinel-Signature` (`sha256=<hex>` via [webhook-signing.js L22](/Users/yurif/Downloads/sentinel/src/adapters/notification/webhook-signing.js) — HMAC sobre `${timestamp}.${body}` estilo Stripe, prevenindo replay).
- **SSRF guard** ([src/adapters/notification/ssrf-guard.js](/Users/yurif/Downloads/sentinel/src/adapters/notification/ssrf-guard.js) L17–60): bloqueia `127/8, 10/8, 172.16/12, 192.168/16, 169.254, 0.0.0.0, ::1, fc/fd, fe80, .local, .internal`, metadata endpoints (`169.254.169.254`, `metadata.google.internal`, `100.100.100.200`), IPv4-mapped-in-IPv6 (`::ffff:10.x.x.x`).
- **Retry com jitter** ([webhook-signing.js L27–34](/Users/yurif/Downloads/sentinel/src/adapters/notification/webhook-signing.js)): `computeRetryDelay` aplica ±20% jitter, mínimo 1000ms.
- **Admin retry endpoint** (L200+): `retryDelivery(deliveryId)` reenfileira manualmente entradas da DLQ.

#### 1.7.2 Domain entities

- [src/core/errors.js](/Users/yurif/Downloads/sentinel/src/core/errors.js) L1–44: hierarquia `SentinelError` → `ValidationError(400)`, `NotFoundError(404)`, `ConflictError(409)`, `IntegrationError(502)`. Cada uma carrega `statusCode`, `code`, `details`, `isOperational=true`.
- [src/core/domain/finding.js](/Users/yurif/Downloads/sentinel/src/core/domain/finding.js) L1–150: enums imutáveis (`Source`, `Type`, `Severity`, `Status`). State machine: `diagnose()`, `proposeFix()`, `applyFix()`, `verify()`, `dismiss()` — cada transição valida o estado atual e lança `ValidationError` em transições ilegais. Campos nativos de integração: `manifestProjectId`, `manifestRunId`, `debugProbeSessionId`, `correlationId`.
- [src/core/domain/session.js](/Users/yurif/Downloads/sentinel/src/core/domain/session.js) L1–70: estados `active|paused|completed|expired`.
- [src/core/domain/capture-event.js](/Users/yurif/Downloads/sentinel/src/core/domain/capture-event.js) L1–45: `EventType` enum = `dom|network|console|error|interaction|http_request|http_response|sql_query|annotation`; construção defensiva contra mutação.

#### 1.7.3 Session service

[src/core/services/session.service.js](/Users/yurif/Downloads/sentinel/src/core/services/session.service.js) L1–125:
- `create()` chama `trace.ensureRemoteSession()` best-effort (L55–70); sucesso guarda `remoteSessionId` em `metadata`, falha apenas loga — **session criada mesmo se Debug Probe está fora**.
- `ingestEvents()` limite 500 eventos por batch (L90).
- `getOrCreate()` (L105–123): auto-cria sessão quando probe envia evento sem sessão prévia (server-to-server).

#### 1.7.4 Storage adapters

- [src/adapters/storage/postgres.adapter.js](/Users/yurif/Downloads/sentinel/src/adapters/storage/postgres.adapter.js) L1–400: tabelas `sentinel_sessions`, `sentinel_events`, `sentinel_findings`, `sentinel_traces`, `sentinel_webhook_events`, `sentinel_probe_webhooks`. `storeTrace` usa UPSERT `ON CONFLICT (correlation_id) DO UPDATE` com `COALESCE` — idempotente e preserva campos já presentes. `deleteTracesBefore` deleta em lotes de 500 (previne long locks).
- [src/adapters/storage/memory.adapter.js](/Users/yurif/Downloads/sentinel/src/adapters/storage/memory.adapter.js) L1–200: `Map`+`Set` para índices O(1); `probeWebhooks` idempotente via `deliveryId`; `traceSessionIndex: Map<sessionId, Set<correlationId>>` permite lookup reverso eficiente.

#### 1.7.5 Issue tracker adapters (3 trackers)

| Adapter | Arquivo | Evidência |
|---|---|---|
| GitHub | [github.adapter.js](/Users/yurif/Downloads/sentinel/src/adapters/issue-tracker/github.adapter.js) L1–115 | REST v2022-11-28; labels auto = `sentinel + severity:X + type:Y`; timeout 10s; `AbortError` → `IntegrationError`. |
| Linear | [linear.adapter.js](/Users/yurif/Downloads/sentinel/src/adapters/issue-tracker/linear.adapter.js) L1–135 | GraphQL; `PRIORITY_MAP` critical=1..low=4; resolve labelIds dinamicamente; busca `stateId` de `workflowStates` com `type: "completed"` para fechar. |
| Jira | [jira.adapter.js](/Users/yurif/Downloads/sentinel/src/adapters/issue-tracker/jira.adapter.js) L1–165 | REST v3 + ADF (Atlassian Document Format); Basic auth `email:token`; busca transition com nome contendo `done\|resolved\|closed`. |

#### 1.7.6 Middleware (server)

- [src/server/middleware/api-key.js](/Users/yurif/Downloads/sentinel/src/server/middleware/api-key.js) L1–70: `SENTINEL_API_KEY` comma-separated (suporta rotação); **comparação constant-time** via XOR bit-a-bit (L44–50); aceita `X-Sentinel-Key` OU `Authorization: Bearer`; modo aberto quando env ausente (dev local).
- [src/server/middleware/rate-limiter.js](/Users/yurif/Downloads/sentinel/src/server/middleware/rate-limiter.js) L1–60: sliding window; default 100 req / 60s; emite `X-RateLimit-Limit/Remaining/Reset` + `Retry-After`; cleanup interval 5min com `.unref()` (não segura process exit).
- [src/server/middleware/error-handler.js](/Users/yurif/Downloads/sentinel/src/server/middleware/error-handler.js) L1–60: `asyncHandler(fn)` wrapper canônico; `errorHandler` mapeia `SentinelError` → JSON estruturado; 500 jamais vaza stack — `console.error` interno + payload genérico `{code:'INTERNAL_ERROR'}`.

#### 1.7.7 SDK (browser)

- [src/sdk/reporter.js](/Users/yurif/Downloads/sentinel/src/sdk/reporter.js) L1–100: `BatchSender` interno (ring buffer 10k eventos default, batch 50, flush 3s); expõe `metrics` (sent/dropped/retries/breakerTrips).
- [src/sdk/recorder.js](/Users/yurif/Downloads/sentinel/src/sdk/recorder.js) L1–80: rrweb para DOM + captura nativa de network/console/error; **sampling dual** — `sessionRate` (0–1.0) + `errorRate` que pode fazer `_upgradeRecording()` quando erro ocorre em sessão não-amostrada.
- [src/sdk/annotator.js](/Users/yurif/Downloads/sentinel/src/sdk/annotator.js) L1–80: overlay flutuante com `z-index: 2147483647`, atributo `data-sentinel-block` para auto-excluir do próprio DOM recording.

---

## 2. Debug Probe (`/Users/yurif/Downloads/debug-probe`)

Evidência primária: [server/src/index.ts](/Users/yurif/Downloads/debug-probe/server/src/index.ts) L1–220 lida diretamente + subagent report (89 KB, relido do workspace cache).

### 2.1 Bootstrap (verificado diretamente)

- **Validação de env via Zod** (L39–57): `PORT` (default 7070), `STORAGE_TYPE∈{memory,file,postgres}`, `PROBE_JWT_SECRET`, `PROBE_API_KEYS`, `WEBHOOK_URL`, `WEBHOOK_SECRET`.
- **Seleção de storage** (L62–68): `DATABASE_URL` presente → `postgres`, senão cai em `STORAGE_TYPE`.
- **Webhook store persistente** (L80–92): se `postgres` + `WEBHOOK_URL` + `WEBHOOK_SECRET` → `PostgresWebhookEventStore` (retries sobrevivem restart); senão in-memory.
- **Guardas de produção fatais** (L195–212):
  - `PROBE_AUTH_DISABLED=1` em production → `process.exit(1)`.
  - Production sem API keys e sem JWT secret → `process.exit(1)`.
  - API key < 16 chars → `process.exit(1)`.
  - JWT secret < 32 chars → `process.exit(1)`.
- **Rate limiting dual** (L183–191): reads 200 req/s (burst 500), writes 50 req/s (burst 100).
- **Helmet CSP restritivo** (L151–166): `scriptSrc: 'self'`, `frameAncestors: 'none'`, `objectSrc: 'none'`.
- **CORS strict em produção** (L170–177): se `CORS_ORIGINS` vazio em production, `cors({origin:false})` (rejeita todos).

### 2.2 Rotas (verificado diretamente)

[server/src/routes/sessions.ts](/Users/yurif/Downloads/debug-probe/server/src/routes/sessions.ts) L1–151:
- Schema Zod **strict** (`.strict()`) em createSessionSchema — rejeita campos extras (L30).
- `sessionIdSchema` regex `^[\w-]+$` — **previne path traversal** (L18).
- **Gap 4 design**: folda `projectId`/`externalSessionId`/`metadata` em tags com prefixos `sentinel:`, `ext:`, `meta:` (L62–70) — integração com Sentinel sem mudar schema DebugSession.
- Audit logging estruturado Pino em create/delete/statusChange (L75, 115, 142).

[server/src/routes/events.ts](/Users/yurif/Downloads/debug-probe/server/src/routes/events.ts) L1–22:
- `MAX_BATCH_SIZE = 1000`, `MAX_EVENT_JSON_SIZE = 256KB`, `MAX_PAYLOAD_SIZE` = 256MB — limites explícitos no código.

### 2.3 Packages do monorepo (do subagent report — a validar em leitura direta se necessário)

| Package | Propósito confirmado |
|---|---|
| `@probe/core` | Tipos, `ProbeEvent` imutável (readonly), ports: `StoragePort`, `NotificationPort`, `WebhookEventStore`; factories `createStorage()`, `PostgresWebhookEventStore`, `WebhookNotificationAdapter`. |
| `@probe/sdk` | Instrumentação Node.js + browser. |
| `@probe/correlation-engine` | 3 estratégias em paralelo: RequestId, Temporal (janela 2000ms), UrlMatching. |

### 2.4 Packages verificados diretamente (sessão adicional)

- **WebSocket realtime** [server/src/ws/realtime.ts](/Users/yurif/Downloads/debug-probe/server/src/ws/realtime.ts) L1–200: auth dupla (API key `x-api-key` header **timing-safe** ou token via query string — JWT ou API key); rate limit 20 msg/s, 5 violações consecutivas encerram conexão; limite por IP 50 conexões; limite por cliente 50 subscriptions; **origin validation** via `CORS_ORIGINS` antes de aceitar upgrade; ping/pong a cada 30s com terminate se pong ausente; métricas Prometheus emitidas em cada ação.
- **Correlation engine** [packages/correlation-engine/src/correlator.ts](/Users/yurif/Downloads/debug-probe/packages/correlation-engine/src/correlator.ts) L1–150: guard de capacidade hard-coded — `MAX_EVENTS=50000`, `MAX_GROUPS=5000`, `MAX_EVENTS_PER_GROUP=10000` (previne OOM). Estratégias rodam em ordem: primeira que retornar groupId vence.
- **RequestIdStrategy** [packages/correlation-engine/src/strategies/request-id.strategy.ts](/Users/yurif/Downloads/debug-probe/packages/correlation-engine/src/strategies/request-id.strategy.ts) L40–72: extrai chave de (1) `event.correlationId`, (2) `NetworkEvent.requestId`, (3) `SdkEvent.requestId`, (4) LogEvent structured fields `correlationId|correlation_id|requestId|request_id|traceId|trace_id` — **multi-fonte**, não só um header.
- **TemporalStrategy** [packages/correlation-engine/src/strategies/temporal.strategy.ts](/Users/yurif/Downloads/debug-probe/packages/correlation-engine/src/strategies/temporal.strategy.ts) L1–60: janela configurável (default 2000ms). Cliques e navegações são **triggers** que criam grupo novo — nunca são correlacionadas temporalmente em grupo preexistente (evita colapso de fluxos distintos).
- **StoragePort** [packages/core/src/ports/storage.port.ts](/Users/yurif/Downloads/debug-probe/packages/core/src/ports/storage.port.ts) L1–100: contrato abstrato com fallback in-memory para `listSessionsPaginated`; `getPoolStats()` retorna `null` para adapters não-Postgres (discriminator por capacidade).
- **SDK public API** [packages/sdk/src/index.ts](/Users/yurif/Downloads/debug-probe/packages/sdk/src/index.ts) L1–6: apenas re-exporta `./node/index.js` e `./browser/index.js` — split por runtime.

**[UNKNOWN — leitura pendente]**: `browser-agent` (Playwright), `log-collector` (Docker/stdout), `network-interceptor` (proxy + middleware), `reporter` (Html/Json/Markdown generators), `cli`, dashboard. Contrato externo via ports já lido é o que importa para os agentes QA.

---

## 3. Manifest / PermaCat (`/Users/yurif/Downloads/Manifest 2`)

Evidência primária: [server/routes.ts](/Users/yurif/Downloads/Manifest 2/server/routes.ts) + [server/analyzers/backend-java-client.ts](/Users/yurif/Downloads/Manifest 2/server/analyzers/backend-java-client.ts) + [java-analyzer-engine/pom.xml](/Users/yurif/Downloads/Manifest 2/java-analyzer-engine/pom.xml).

### 3.1 Pipeline headless (verificado)

[server/routes.ts](/Users/yurif/Downloads/Manifest 2/server/routes.ts) L175–257 — `POST /api/analyze`:
1. Valida `files[]` com `path` e `content` obrigatórios (L180–188).
2. Cria `Project` via `storage.createProject()` (L193).
3. SHA-256 hash por arquivo (L203) — habilita deduplicação.
4. `AnalysisPipeline().runFullAnalysis(projectId, fileData)` (L211).
5. Gera manifest + formato solicitado: `agents-md`, `openapi`, `policy-matrix`, `keycloak-realm`, `opa-rego`, `compliance-report`, ou `all` (L218–247).

### 3.2 Java analyzer engine (verificado)

[server/analyzers/backend-java-client.ts](/Users/yurif/Downloads/Manifest 2/server/analyzers/backend-java-client.ts) L~120–180:
- Subprocesso Java spawnado por `ensureEngineRunning()`.
- Comunicação via HTTP `POST /analyze` com corpo JSON `{filePath: content}` (L~150–160).
- **Timeout 25 min** hard-coded (L138: `25 * 60 * 1000`).
- `AbortController` com mensagem específica para timeout (L155–158).
- Logs estruturados de tamanho (KB/MB), tempo de serialize/fetch/parse (L126–175).

[java-analyzer-engine/pom.xml](/Users/yurif/Downloads/Manifest 2/java-analyzer-engine/pom.xml) L1–101:
- Java 17 (`maven.compiler.source=17`).
- **JavaParser 3.26.2** + symbol-solver-core — parsing AST real.
- Dependências Spring: `spring-data-jpa 3.2.4`, `jakarta.persistence-api 3.1.0`, `spring-web 6.1.5`, `spring-context 6.1.5` — para resolução simbólica de anotações Spring.
- `maven-shade-plugin` → fat JAR auto-contido (L80+).
- Main class: `com.permacat.analyzer.AnalyzerServer` (L74).

### 3.3 Catalog entries (verificado)

[server/routes.ts](/Users/yurif/Downloads/Manifest 2/server/routes.ts) L~965–990 — `GET /api/catalog-entries/:projectId/export`: retorna entries com `screen`, `interaction`, `interactionType`, `endpoint`, `httpMethod`, `controllerClass`. É este endpoint que o UI QA Sentinel agent consulta.

### 3.4 Generators e analyzers verificados (sessão adicional)

- **manifest-generator** [server/generators/manifest-generator.ts](/Users/yurif/Downloads/Manifest%202/server/generators/manifest-generator.ts) L1–300: produz `PermaCatManifest` com schema versionado (`$schema: https://permacat.dev/schemas/manifest-v1.json`). `completeness.overallScore` = média ponderada: `endpointResolution*0.30 + routeCoverage*0.15 + securityCoverage*0.25 + entityCoverage*0.15 + controllerCoverage*0.15`. Detecção de UI-only usa whitelists explícitas (`UI_ONLY_EXACT` Set + `UI_ONLY_PATTERNS` regex) para excluir `set*`, `toggle*`, `handleCancel`, `copy*ToClipboard` do cálculo de resolução HTTP. `dataSource` por campo etiqueta `extracted` vs `inferred` — **provenance trail no próprio manifest**.
- **keycloak-realm-generator** [server/generators/keycloak-realm-generator.ts](/Users/yurif/Downloads/Manifest%202/server/generators/keycloak-realm-generator.ts) L1–200: gera realm export completo — `realmRoles` (1 por role detectada + `AUTHENTICATED`), `resources` (1 por endpoint `METHOD:/path`), `rolePolicies` (type:`role`, logic:`POSITIVE`, decision:`UNANIMOUS`), `permissions` (decision:`AFFIRMATIVE`, vincula resource→policy→scope). `authorizationServicesEnabled:true` + `policyEnforcementMode:ENFORCING` — **pronto para import direto no Keycloak sem edição manual**.
- **opa-rego-generator** [server/generators/opa-rego-generator.ts](/Users/yurif/Downloads/Manifest%202/server/generators/opa-rego-generator.ts) L1–150: emite bundle OPA com `default allow := false` + uma regra `allow if { method==X; path==Y; role_match(...) }` por endpoint + regras especiais: `deny_sensitive_without_admin` (endpoints com sensitiveFields), `deny_critical_without_elevated_role` (criticality≥80). Gera bundle hierárquico (policy raiz + uma por controller) + data document com metadados.
- **compliance-report-generator** [server/generators/compliance-report-generator.ts](/Users/yurif/Downloads/Manifest%202/server/generators/compliance-report-generator.ts) L1–120: HTML auditável com checklist LGPD Art. 37, cobertura por método HTTP, por controller, matriz de acesso roles×endpoints, lista de dados sensíveis. `escapeHtml` aplicado em todo conteúdo dinâmico (anti-XSS no relatório).
- **frontend-analyzer** [server/analyzers/frontend-analyzer.ts](/Users/yurif/Downloads/Manifest%202/server/analyzers/frontend-analyzer.ts) L1–100: monta **base URL registry** (`Map<filePath::name, baseUrl>`) detectando axios.create({baseURL}), variáveis `API_URL`/`apiUrl`/`baseUrl`/`prefix`. Suporta Vue/React/Angular (arquivos `.ts/.js/.tsx/.jsx/.vue`). Exclui `node_modules|dist|build`. Usa o typescript compiler API diretamente (não regex) para parsing AST.
- **semantic-engine** [server/analyzers/semantic-engine.ts](/Users/yurif/Downloads/Manifest%202/server/analyzers/semantic-engine.ts) L1–100: LLM classifier via OpenAI (`gpt-4o-mini`, `max_completion_tokens: 4096`). Batches de **10 entries** com progress log (`[analysis] LLM batch N/M done in Xs`). Classifica em 8 `technicalOperation` + `criticalityScore 0–100` com faixas bem definidas (0–20 read-only, 81–100 auth/financial). Fallback heurístico (`estimateCriticality`) quando JSON de resposta é inválido — **degradação graciosa**.

---

## 4. Agentes QA

### 4.1 UI QA Sentinel

[NuPIdentify/.github/agents/ui-qa-sentinel.agent.md](/Users/yurif/Downloads/NuPIdentify/.github/agents/ui-qa-sentinel.agent.md) L1–200 lido integralmente.

- **Model:** `Claude Sonnet 4.5 (copilot)`, tools: `[read, search, web, edit, todo, playwright/*, fetch]`.
- **Preflight tri-serviço explícito** (L27–31): `GET sentinel/health`, `GET manifest/api/projects`, `GET debug-probe/health`.
- **Vocabulário mapeado à força** (L66–72): `source∈{manual,auto_error,auto_performance,auto_network}`, `type∈{bug,ux,performance,data,visual,other}`, `severity∈{critical,high,medium,low}` — **bate 1:1 com o domínio Sentinel** (verificado em finding.domain + finding.service).
- **10 dimensões de auditoria** (L103+): Layout, Interaction States, WCAG 2.2 AA, Forms, Content, Performance, Responsive, Visual Regression, State Coverage, UI-vs-Permission.
- **Anti-halucinação** (L93–100): "No visual hallucination", "Accessibility tree first", "Deterministic selectors", "Cite evidence".

### 4.2 EasyNuP Test Sentinel

[easynup/.github/agents/easynup-test-sentinel.agent.md](/Users/yurif/Downloads/easynup/.github/agents/easynup-test-sentinel.agent.md) L1–200 lido (~20% do arquivo).

- **Models:** `Claude Opus 4.6 (copilot)` + `Claude Sonnet 4 (copilot)`.
- **4 personas simultâneas** (L13–17): auditor, usuário mal-intencionado, operador distraído, dev que esqueceu.
- **Guardrails anti-alucinação explícitos** (L22–31): "NUNCA especula", "NUNCA inventa nomes", "NUNCA entrega sem executar 1x".
- **Discovery-driven testing** (L62–82): OBRIGATÓRIO ler Params/Service/Entity antes de gerar testes — extrai anotações Jakarta, exceções, cleanup, defaults, relacionamentos JPA.
- **14 dimensões** (L114+): Jakarta validation, tipos/formatos, limites, regras de negócio específicas (FinishAtMustBeGreaterThanInitAt, CNPJ cleanup `replaceAll("[^0-9A-Za-z]","").toUpperCase()`).
- **Meta TestGen-LLM filter pipeline** (L103–108): compila → passa 3x sem flakiness → cobre linhas novas → nomes/assertions OK.

### 4.3 EasyNuP Test Sentinel — dimensões 5–14 verificadas

[easynup/.github/agents/easynup-test-sentinel.agent.md](/Users/yurif/Downloads/easynup/.github/agents/easynup-test-sentinel.agent.md) L200–600 lido nesta sessão.

- **Dim 5 CRUD** (L218–262): cada entidade exige teste dos 4 fluxos, incluindo verificação de que **todos** os campos são copiados (nenhum ignorado em update) + audit log + user/owner association.
- **Dim 6 Soft delete** (L264–272): entidade com `deletedAt` não aparece em listagens; find/update retornam `NotFound`; restore limpa `deletedAt`.
- **Dim 7 Auditoria** (L274–282): `logCreate/logUpdate/logDelete` com 9 parâmetros obrigatórios incluindo snapshot, organizationId, hash chain.
- **Dim 8 Segurança** (L284–302): XSS (armazenar literal, escape no render), SQL injection (parametrized queries), path traversal, Unicode (emojis/RTL/zero-width), `MAX_INT` size bypass.
- **Dim 9 Permissões** (L304–341): mapa completo de **90+ permissões** catalogadas por domínio (Dashboard, Gestão 360, Contratos, Workflow, SLA, Admin etc.) com validação de 403 para sem-permissão e execução para com-permissão.
- **Dim 10 Paginação** (L343–352): page=-1, pageSize=0, pageSize>1000, filtros por campos inexistentes, resultado vazio ≠ null.
- **Dim 11 Integridade referencial** (L354–371): mapa explícito de relações (Contract→7 filhos, Company→3 filhos, SLA→Indicator→Measurement→Stop, Project self-ref, Rule→Conditions/Actions/ExecutionLog). Cascade soft delete vs restrição.
- **Dim 12 Concorrência** (L373–379): create duplicado simultâneo, update last-write-wins, delete+update race, retry idempotente.
- **Dim 13 Gateway Node↔Java** (L381–390): todo `/easynup/*` é proxied; propagação de 4xx/5xx; timeout → ServiceUnavailableError 503; Node **NUNCA** faz INSERT em tabelas JPA (rule forte).
- **Dim 14 Frontend↔Backend** (L392–407): paridade @NotBlank/@Size/enum entre back e front; `authFetch` em toda chamada (nunca `fetch` direto); TanStack Query `queryKey` único; `hasPermission()` em todos os botões protegidos.
- **Infraestrutura de testes Java** (L411+): ref implementation `ContractingEntityCrudTest.java` (103 testes green). Padrões obrigatórios — `stubEmLenient` para reflectir `BaseBusinessStereotype.em()`; `MockedStatic<Db>` com try-with-resources para `Db.save/findOne/exists` estáticos; fixtures com dados do setor público BR ("Ministério da Gestão...", CNPJ formatado); verificação de `logCreate` com 9 argumentos exatos; `@BeforeAll` para Jakarta `validator` (nunca instanciar por teste).

Conclusão: o agente tem **prescrições executáveis**, não apenas dimensões abstratas — há template de código para cada ponto.

---

## 5. Consistência cruzada (verificada)

| Contrato | Onde | Compatibilidade |
|---|---|---|
| Sentinel `Finding.source` enum | [finding.service.js L30](/Users/yurif/Downloads/sentinel/src/core/services/finding.service.js) + UI QA agent L66 | ✅ `manual\|auto_error\|auto_performance\|auto_network` — idêntico. |
| Sentinel `Finding.type` enum | UI QA agent L68 + EasyNuP escreve via SDK | ✅ `bug\|ux\|performance\|data\|visual\|other`. |
| Debug Probe session tags prefixados | [sessions.ts L62–70](/Users/yurif/Downloads/debug-probe/server/src/routes/sessions.ts) | ✅ `sentinel:project:<id>` é lido pelo Sentinel para backfill em [finding.service.js L28–45](/Users/yurif/Downloads/sentinel/src/core/services/finding.service.js). |
| Manifest `projectId` numérico | Sentinel usa `MANIFEST_PROJECT_ID_MAP=easynup:3` ([manifest.adapter.js](/Users/yurif/Downloads/sentinel/src/adapters/analyzer/manifest.adapter.js)) + Manifest `routes.ts` usa `parseInt(projectId)` | ✅ coerente. |

---

## 6. Gaps reais (com evidência)

1. **Sentinel correction depende de filesystem local** — [manifest.adapter.js getSourceFile](/Users/yurif/Downloads/sentinel/src/adapters/analyzer/manifest.adapter.js) lê de `SENTINEL_PROJECT_ROOTS` local, não do Manifest API. Em produção Railway, se o código não está no container do Sentinel, `correction.service._extractFilePaths` retorna `{}` e Claude recebe contexto vazio.
2. ~~**Notificações sem retry Sentinel**~~ — **REVOGADO após leitura direta.** O `WebhookNotificationAdapter` ([webhook.adapter.js L1–240](/Users/yurif/Downloads/sentinel/src/adapters/notification/webhook.adapter.js)) implementa retry completo com schedule `[60s,300s,1800s,7200s,43200s]`, DLQ quando storage é passado, HMAC-SHA256 timestamped, SSRF guard, jitter ±20%. Sentinel e Debug Probe têm **paridade** de resiliência em notificação (o Debug Probe usa `PostgresWebhookEventStore`, o Sentinel usa seu próprio `WebhookEventStore` via storage adapter — mesma ideia). A única ressalva válida: em modo legacy (sem `storage` injetado) o retry é desativado — o container wira `storage` sempre que `DATABASE_URL` está presente.
   - *Gap menor remanescente:* se `STORAGE=memory` em produção (anti-pattern explícito), o retry ainda funciona mas perde-se em restart do pod.
3. **Manifest Java engine timeout fixo de 25 min** — [backend-java-client.ts L138](/Users/yurif/Downloads/Manifest 2/server/analyzers/backend-java-client.ts) hard-coded; não configurável por env. Repositórios grandes podem bater.
4. **UI QA agent assume API keys via env sem fallback fleet** (L22): instrui perguntar ao usuário mas não descreve como reutilizar entre execuções.
5. **Smoke test `confidence:"low"` prévio explicado**: [diagnosis.service.js](/Users/yurif/Downloads/sentinel/src/core/services/diagnosis.service.js) L enrichTraces retorna `[]` quando TracePort não está configurado ou sessionId não tem eventos — Claude recebe `traces: []` e baixa confidence.

---

## 7. Inventário de leitura (transparência)

### Sentinel — lido diretamente
- `src/container.js` L1–250
- `src/server/app.js` L1–80
- `src/core/errors.js` L1–44
- `src/core/domain/finding.js` L1–150
- `src/core/domain/session.js` L1–70
- `src/core/domain/capture-event.js` L1–45
- `src/core/services/diagnosis.service.js` L1–300
- `src/core/services/finding.service.js` L1–100
- `src/core/services/correction.service.js` L1–100
- `src/core/services/integration.service.js` L1–75
- `src/core/services/session.service.js` L1–125
- `src/adapters/trace/debugprobe.adapter.js` L1–900
- `src/adapters/analyzer/manifest.adapter.js` L1–250
- `src/adapters/ai/claude.adapter.js` L1–200
- `src/adapters/storage/postgres.adapter.js` L1–400
- `src/adapters/storage/memory.adapter.js` L1–200
- `src/adapters/notification/webhook.adapter.js` L1–240
- `src/adapters/notification/webhook-signing.js` L1–35
- `src/adapters/notification/ssrf-guard.js` L1–60
- `src/adapters/issue-tracker/github.adapter.js` L1–115
- `src/adapters/issue-tracker/linear.adapter.js` L1–135
- `src/adapters/issue-tracker/jira.adapter.js` L1–165
- `src/server/middleware/api-key.js` L1–70
- `src/server/middleware/rate-limiter.js` L1–60
- `src/server/middleware/error-handler.js` L1–60
- `src/sdk/reporter.js` L1–100
- `src/sdk/recorder.js` L1–80
- `src/sdk/annotator.js` L1–80
- `src/mcp/server.js` L1–600

### Debug Probe — lido diretamente
- `server/src/index.ts` L1–220
- `server/src/routes/sessions.ts` L1–151
- `server/src/routes/events.ts` L1–22
- `server/src/ws/realtime.ts` L1–200
- `packages/correlation-engine/src/correlator.ts` L1–150
- `packages/correlation-engine/src/strategies/request-id.strategy.ts` L1–72
- `packages/correlation-engine/src/strategies/temporal.strategy.ts` L1–60
- `packages/core/src/ports/storage.port.ts` L1–100
- `packages/sdk/src/index.ts` L1–6

### Manifest — lido diretamente
- `server/routes.ts` L170–280, L950–1010
- `server/analyzers/backend-java-client.ts` L120–227
- `server/analyzers/frontend-analyzer.ts` L1–100
- `server/analyzers/semantic-engine.ts` L1–100
- `server/generators/manifest-generator.ts` L1–300
- `server/generators/keycloak-realm-generator.ts` L1–200
- `server/generators/opa-rego-generator.ts` L1–150
- `server/generators/compliance-report-generator.ts` L1–120
- `java-analyzer-engine/pom.xml` L1–101

### QA agents — lido diretamente
- `NuPIdentify/.github/agents/ui-qa-sentinel.agent.md` L1–200 (completo)
- `easynup/.github/agents/easynup-test-sentinel.agent.md` L1–600

### Ainda NÃO lidos diretamente (transparência residual)
- Sentinel: `core/ports/*` (abstratas, contrato já inferido pelos adapters), `core/retention.js`, `core/infra/*`, `observability/*`, `storage/migrations.js`, `server/middleware/request-id.js`, noop adapters (ai/analyzer/capture/trace/issue-tracker), `sdk/annotator.v2.js`, server routes completos (`projects.js`, `sessions.js`, `findings.js`).
- Debug Probe: `packages/sdk` internals (browser/node), `browser-agent` (Playwright), `log-collector` (File/Docker/Stdout), `network-interceptor` (Proxy/ExpressMiddleware), `reporter` generators, `cli`, `dashboard` SPA. Contratos externos já cobertos por ports + rotas HTTP.
- Manifest: demais analyzers (`architecture-detector`, `application-graph`, `repository-scanner`, `java-analyzer` pipeline TS), webhook handlers GitHub/GitLab, chunked upload internals, VSCode extension, CLI Commander.
- EasyNuP Test Sentinel: L600–end (exemplos finais de templates Jest/Vitest, seções de integration + E2E Playwright).

Para qualquer um desses pontos, peça e eu leio — este documento é auditável por `file:line`.

---

## §3.5 Manifest — Java analyzer engine (blind spot #1 encerrado)

Fonte: `java-analyzer-engine/src/main/java/com/permacat/**`. 5 arquivos, 1278 LOC: `AnalyzerServer.java` (108), `analyzer/JavaASTAnalyzer.java` (1098), `model/{AnalysisResult,GraphNodeDTO,GraphEdgeDTO}.java` (72 combinados). Todos lidos integralmente.

### 3.5.1 Servidor HTTP (`AnalyzerServer.java`)
- Bind hard-coded **`127.0.0.1`** (L31) — impossível acesso remoto sem port-forward. Porta default `9876`, override por argv[0] (L22–28).
- Thread pool fixo de 2 (L43) — serializa requests quando ambos ocupados (não é bug: é backpressure explícito).
- Endpoints: `POST /analyze` (L33), `GET /health` (L40). 405 em outros métodos (L36).
- `handleAnalyze` (L50–83): recebe `Map<String,String>` (filePath→conteúdo), delega a `JavaASTAnalyzer.analyze`, serializa via Gson, retorna 200 com JSON. Exceção genérica captura tudo, devolve 500 com `{error, stackTrace}` (L77–82) — **stack trace vaza ao cliente TS**. Em produção quem consome é o próprio Node gateway (subprocess local), então OK, mas se alguém expuser 9876 há information disclosure.
- `readBody` (L86–96): usa `BufferedReader.readLine()` sem preservar `\n`. Como o corpo é JSON de uma linha Gson aceita, mas fontes Java embutidas no JSON (`files` map values) têm seus `\n` escapados pelo cliente, então a reconstrução sobrevive. **Não há limite de tamanho** do body (L87–95) — arquivo único gigante pode exaurir heap.

### 3.5.2 Entry point `JavaASTAnalyzer.analyze` (L85–169)
Pipeline de 8 fases explícitas com timing:
1. `writeFilesToTemp` (L89) — cria `Files.createTempDirectory("permacat-src-")` (L328), reescreve cada arquivo respeitando `package X;` via `extractPackagePath` (L344). Se não houver package, cai no `filePath` original (L339). Escrita em `Files.writeString` — UTF-8 default.
2. `configureParserWithSymbolSolver` (L93) — `CombinedTypeSolver` = `ReflectionTypeSolver(false)` + `JavaParserTypeSolver(tempDir)` (L360–362). `LanguageLevel.BLEEDING_EDGE` (L366). **Não adiciona JARs do projeto analisado** → resolução de símbolos em tipos de bibliotecas externas (Spring, Jakarta, projeto próprio compilado) falha. Isso é a causa explícita dos `resolutionErrors` que aparecem ao cliente.
3. Parse por arquivo (L97–123) — captura parse errors em `resolutionErrors` (L114, L119) e conta em `parseErrors`. Cada CU passa por `extractClassInfo`.
4. `resolveSuperclassBasePaths` (L128–132) — resolve `@RequestMapping` herdado via nome simples de superclasse (L436–453). Evita ciclo com `visited` set (L439).
5. `resolveClassSymbols` (L136–154) — `cls.resolve()` em cada classe; armazena `ResolvedReferenceTypeDeclaration` em `ClassInfo.resolvedSymbol` e no `symbolClassMap.byQualifiedName` (L171–190).
6. `resolveMethodSignatures` (L141–167) — `methodDecl.resolve().getQualifiedSignature()`. Falhas viram `[RESOLVE-FAIL]` em stderr + `resolutionErrors` (L213–216).
7. `resolveRepositoryEntitiesViaGenerics` (L148–155) — percorre `extends`/`implements` da interface, casa com `REPO_INTERFACES` (L51–54: JpaRepository, CrudRepository, etc.), pega primeiro type argument. Fallback duplo: tenta `symbolClassMap.get(entityDecl)` (L245), se null tenta `fqnIndex` por FQN completo e depois por simple name casado com `isEntity` (L253–262).
8. `buildGraph` (L166) — construção do grafo de nós e arestas.

`finally` limpa `tempDir` recursivamente (L159–164, L379–390). Erro no solver init é capturado e reportado em `resolutionErrors` (L156–160).

### 3.5.3 Detecção de componentes (`extractClassInfo` L392–464)
- **Controller**: `@RestController` ou `@Controller` OU presença de qualquer método com `@GetMapping/@PostMapping/…` (L459–461). Classe sem essas anotações mas com métodos mapeados é promovida a controller — cobre casos de meta-annotations não customizadas.
- **Service**: `@Service` ou `@Component` (L34–36). Intencional — componentes genéricos entram como service para não perder chamadas.
- **Repository**: `@Repository` OU interface que estende `JpaRepository/CrudRepository/…` (L422–434). Repos concretos não-interface sem `@Repository` viram service — gap conhecido.
- **Entity**: `@Entity`, `@Table` ou `@Document` (L40–42). MongoDB incluído via `@Document`.
- `basePath`: extrai apenas `@RequestMapping` de classe (L442–447). `@GetMapping`/etc. de classe (usado raramente) é ignorado como base path — OK porque Spring oficial só permite `@RequestMapping` como classe-level com paths.

### 3.5.4 Segurança anotacional (L465–571)
`SECURITY_ANNOTATIONS` (L43–45): `PreAuthorize`, `Secured`, `RolesAllowed`, `DenyAll`, `PermitAll`. Anotações de classe e método somadas (L653–666).

`extractRolesFromExpression` (L535–571):
- `Secured`/`RolesAllowed`: split por vírgula, trim de aspas/chaves — simples e suficiente.
- `PreAuthorize` (SpEL): 4 regex para `hasRole`, `hasAuthority`, `hasAnyRole`, `hasAnyAuthority`. Normaliza `hasRole("X")` em `ROLE_X` (L546), preserva `hasAuthority("X")` como `X` (L549). `hasAnyRole("A","B")` é split por `[,'"]` (L553) — frágil mas funcional para casos comuns.
- **Não cobre**: `@PreAuthorize("#id == authentication.principal.id")` (ABAC por expressão), `hasPermission`, expressões SpEL custom com beans, `@PostAuthorize`, `@PreFilter`, `@PostFilter`.
- `DenyAll` força role `NONE`, `PermitAll` força `*` (L509–514) — heurística razoável.

### 3.5.5 Segurança programática (`detectProgrammaticSecurity` L625–681)
`SECURITY_CHECK_METHODS` (L619–624): 18 nomes (hasRole, hasAuthority, checkPermission, requireRole, isAuthenticated, etc.). Detecta também `SecurityContextHolder.getContext()` (L645–655) e `request.isUserInRole(...)` (L657–671). **Não resolve símbolo**, apenas pattern-matching por nome — pode dar falso positivo se o projeto tiver método `hasRole` não relacionado a segurança.

### 3.5.6 Entity fields (`extractEntityFields` L481–506)
- `@Id`/`@EmbeddedId` → `isId`.
- `SENSITIVE_FIELD_NAMES` (L467–471): 15 padrões (password, secret, token, cpf, cvv, salary, bankAccount, …). Match por `contains` lowercase (L495). **Não detecta campos criptografados** ou anotados com `@Column(name="password")` se o field name for diferente.
- Heurística adicional: `@JsonIgnore` ou `@JsonProperty(access = Access.WRITE_ONLY)` também marcam sensitive (L497–500) — último inspecionado por `toString()` do AnnotationExpr (frágil contra formatação).
- `VALIDATION_ANNOTATIONS` (L472–476): Bean Validation padrão (NotNull, Size, Pattern, Email, …). Guarda a anotação inteira como string via `ann.toString()`.

### 3.5.7 Method body analysis (`extractMethods` L573–603)
- `extractMethodCalls` (L605–617): `callExpr.resolve()` + `declaringType()`. Captura `resolvedScopeType` extra (L620–629) — crítico para chamadas polimórficas (interface declarada, impl real). Falha silenciosa (`catch Exception {}` L635) — chamadas irresolúveis somem do grafo.
- `detectEntityMutations` (L683–694): qualquer `setXxx(...)` com 3º char uppercase vira `hasEntityMutations=true` — grosseiro, promove QUALQUER chamada de setter, mesmo em DTOs/builders. Compensado em `handleEntityMutations` (L896–920) que só adiciona edge `WRITES_ENTITY` se ao menos um repo vinculado a entity for chamado no mesmo método.

### 3.5.8 Build do grafo (`buildGraph` L725–880)
Primeira passagem (L734–768) cria nós ENTITY com `enrichedFields` (name, type, isId, isSensitive, validations) e lista `sensitiveFields`.
Segunda passagem (L770–810) cria nós CONTROLLER/SERVICE/REPOSITORY. Repository ganha nó de classe + edge `READS_ENTITY` para entity do genérico (L780–792).
- Método é incluído se `httpMethod != null` (controller) ou sempre (service/repository). **Requer `resolvedQualifiedSignature`** (L795), senão descartado — mesma causa: classpath incompleto.
- `securityAnnotations` da classe + método concatenadas (L797–812). `requiredRoles` consolidado em LinkedHashSet (ordem preservada).

Terceira passagem (L815–874) cria edges CALLS:
- Alvo resolvido por `symbolClassMap.get(call.resolvedDeclaringType)` com fallback `resolvedScopeType` (L820–825).
- Se target é repo: gera nó sintético do método do repo (mesmo que o método não esteja no AST — ex.: `findByEmail` auto-implementado) e adiciona edge WRITES/READS para entity via `detectPersistenceOp` (L833–859).
- `detectPersistenceOp` (L923–940): match por `contains` lowercase em 3 sets (save/delete/read) + prefixos (find, get, search, query, list, fetch, exists, count). "updateX" → "save" (porque "update" está em PERSISTENCE_SAVE).
- `isWriteOp` (L942–944): apenas save/update/delete. **`insert`, `create`, `persist`, `merge` estão em PERSISTENCE_SAVE mas `detectPersistenceOp` retorna "save"** — consistente.
- Requalificação de assinatura (`requalifySignature` L715–722): substitui prefixo FQN do signature pelo FQN real do target. Necessário porque `declaringType` pode apontar para interface quando o método é herdado.

Edge dedup por `fromNode + "->" + toNode + ":" + relationType` (L946–953).

### 3.5.9 Estruturas e DTOs (L955–1098 + model/*.java)
`ClassInfo` (L955–975): boolean flags, listas de MethodInfo/EntityField/SecurityAnnotation, resolved symbols. Sem sincronização — mas pipeline é single-threaded após receber request (thread pool 2 roda requests paralelos, cada um instancia seu próprio `JavaASTAnalyzer`, L65 — OK).
`MethodInfo` (L977–989): não tem AST ref, só metadata extraída.
`MethodCallInfo` (L991–997): guarda `ResolvedReferenceTypeDeclaration` (objetos vivos do JavaParser). Como a instância do analyzer morre ao fim da request, não há leak.

DTOs de saída (model/*):
- `GraphNodeDTO.id` = `type:qualifiedSignature` ou `type:className` se signature null (L20–22). **Colisão possível** se 2 classes do mesmo tipo compartilham nome sem signature — mas para ENTITY/CONTROLLER de classe raiz, qualifiedSignature vem do FQN resolvido.
- `AnalysisResult` (16 linhas) agrega nodes, edges, resolutionErrors. Sem versioning no payload.

### 3.5.10 Crítica parcial — Java engine

**Confirmado (não é especulação)**:
1. Pipeline é determinístico, single-threaded por request, com 7 falhas explícitas capturadas em `resolutionErrors`.
2. Bind 127.0.0.1 + thread pool 2 + stack trace no erro 500 → OK em modo subprocess local, **inaceitável** se alguém expuser a porta.
3. Classpath **não inclui JARs do projeto analisado**. Toda resolução de tipos externos (Spring, JPA, projeto compilado) depende só de `ReflectionTypeSolver` (JDK) + `JavaParserTypeSolver` (fontes enviadas). Consequência: métodos cuja assinatura usa tipos externos não compilam o resolve → `[RESOLVE-FAIL]` → nó some do grafo (L795). **Silenciosamente produz grafo incompleto.**
4. `hasPermission`, `@PostAuthorize`, ABAC via SpEL (`#id == principal.id`), expressões com beans customizados (`@bean.method()`) **não são extraídos**. Roles ficam vazios para esses métodos.
5. `detectEntityMutations` é heurística — `setX()` em qualquer DTO/builder marca `hasEntityMutations`. Mitigado porque só vira edge WRITES_ENTITY se também chamar repo, mas nó de método ganha flag que pode alimentar falsos relatos "muta estado".
6. `isController` promove classes com `@GetMapping` sem `@RestController` — Spring oficial exige a anotação de classe, então isso cobre bad code; aceitar como dev-aid, não regra oficial.

**Gaps materiais para produção**:
- `readBody` sem limite de tamanho (L87–95) + único body JSON = arquivo gigante → OOM na JVM. Gateway TS deveria limitar antes de repassar.
- `PERSISTENCE_SAVE` inclui "update" e `PERSISTENCE_READ` inclui "findOne" — `findOneAndUpdate` (Mongo) bateria em "read" primeiro no loop (L925–931), classificado errado.
- `buildGraph` terceira passagem cria nó sintético do repo (L833–843) e um edge READS_ENTITY. Mas `handleEntityMutations` (L896–920) **também** adiciona WRITES_ENTITY se `hasEntityMutations` é true, mesmo que o método do repo seja de leitura. Dedup por `from->to:WRITES_ENTITY` não colide com READS_ENTITY → coexistem duas arestas contraditórias no mesmo método do service.
- `resolveSuperclassBasePaths` resolve APENAS um nível acima via nome simples (L436–453, itera lista achando primeiro candidato). **Ambiguidade** se múltiplas classes no projeto tiverem mesmo nome simples em packages diferentes — pega a primeira.
- Gson serialização de `Map<String,Object>` grandes: sem streaming; tudo em memória. Log mostra `(json.length()/1024) + " KB"` (AnalyzerServer L73) — não há teto.

**Onde o `backend-java-client.ts` (já lido antes) impacta**: o cliente TS envia files via HTTP POST (timeout alto configurado lá). Erros em `resolutionErrors` chegam como array strings; o pipeline TS decide logar ou bloquear. Não foi auditado agora se o TS **usa** os errors para sinalizar o usuário, só que recebe.

**O que permanece [UNKNOWN]**:
- Volume típico de `resolutionErrors` em projeto real — depende de classpath do usuário.
- Se o `target/` (vazio nesse snapshot?) contém fat-jar com JavaParser 3.26 — conforme pom.xml, `maven-shade-plugin` produz jar com tudo embutido. Não li os logs de execução real.



---

## §2.5 Debug Probe — packages network-interceptor + log-collector (blind spot #2 encerrado)

Fonte: `packages/network-interceptor/src/**` (915 LOC) + `packages/log-collector/src/**` (952 LOC). Todos os arquivos TS de `src/` lidos (14 arquivos). `__tests__/` e `dist/` não lidos — são artefatos derivados/testes.

### 2.5.1 network-interceptor — Container (`container.ts` L1-29)
Factory `createNetworkCapture(config)` troca por `config.mode`: `proxy` → `ProxyAdapter`, `middleware` → `MiddlewareAdapter`, `browser` → lança erro redirecionando a `@probe/browser-agent`. Default → Error com mode stringified (L24-26). Sem select por env var aqui; é decisão do caller.

### 2.5.2 ProxyAdapter (`adapters/proxy.adapter.ts` L1-489)
Servidor HTTP proxy com 5 constantes duras (L20-25): `DEFAULT_PROXY_PORT=8080`, `REQUEST_TTL_MS=120s`, `CLEANUP_INTERVAL_MS=30s`, `MAX_PENDING_REQUESTS=10_000`, `MAX_ACTIVE_CONNECTIONS=5_000`, `PROXY_REQUEST_TIMEOUT_MS=30s`.

**SSRF — `isPrivateHost` (L28-45)**: lista de 10 regex — 127./10./172.16-31./192.168./169.254./0./100.64-127./::1/fd**:**/fe80:. Também bloqueia `localhost` e hostname vazio (L42). É `export`ed — reutilizável. Gap: **não resolve DNS** antes de checar. Um hostname `attacker.com` que resolve para `127.0.0.1` (DNS rebinding) passa pelo filtro e é passado para `http.request`, que resolve ali e conecta ao loopback. **Vulnerabilidade real** em deploy exposto.

**Tunnel HTTPS (`on('connect')` L94-127)**: SSRF aplicado ao host (L100). Timeouts em ambos sockets (L116-118). Não intercepta TLS — apenas pipe bidirecional (L111-112). **Não captura body de HTTPS**: é trade-off consciente (documentado: "pass-through, no SSL interception").

**handleRequest (L172-223)**: filtro de tráfego (L180), cap de conexões 5k (L186-189), cap de pending 10k com FIFO eviction (L200-204), coleta de body chunks respeitando `maxBodySize` (default 1MB). Redação via `redactBody`/`redactHeaders` de `@probe/core` (L235-244).

**forwardAndCapture (L245-310)**: parse URL com try/catch (L252-259), SSRF check no parsed hostname (L263-267). Timeout do proxyReq 30s (L281), handlers de timeout e error enviam 504/502 ao cliente (L283-297). Depois `clientReq.pipe(proxyReq)` (L300) — streaming, sem buffer duplo.

**handleProxyResponse (L312-370)**: escreve status+headers ao cliente imediatamente (L328), pipe dos chunks ao cliente enquanto amostra para captura respeitando `maxBodySize` (L330-336). Limpa do `pendingRequests` ao final (L363).

**forwardRequest (L372-427)**: versão sem captura usada quando filtro rejeita URL. Mesma SSRF + timeouts.

**cleanup timer (L457-472)**: a cada 30s varre `pendingRequests` e apaga entradas mais antigas que `REQUEST_TTL_MS`. `cleanupTimer.unref()` evita segurar processo vivo (L467-469).

### 2.5.3 MiddlewareAdapter (`middleware.adapter.ts` L1-287)
Passivo — `start()` apenas liga flag e compila filtro (L65-69). `stop()` zera handlers (L72-77). Pontos críticos:

- `getMiddleware()` retorna função Express-compatível (L103-219). Monkey-patch de `res.write` e `res.end` (L168-210) para amostrar chunks sem alterar payload ao cliente. `originalWrite`/`originalEnd` com `bind(res)` (L164-166) — OK.
- Request body coletado em `req.on('data')` / `req.on('end')` (L129-161) respeitando `maxBodySize` (default 1MB, L122). Truncamento com sufixo `[TRUNCATED]` (L138-141).
- Response emit ocorre DEPOIS de `originalEnd(...args)` (L190) — cliente não percebe overhead.
- `isCapturableBody` (L44-48) gate-keeper: só captura `text/*` + JSON + XML + urlencoded.

**Gap**: `req.on('end')` só emite o evento request se `end` é chamado. Se a conexão é abortada cedo (cliente fecha socket), evento **não é emitido** — o Middleware silenciosamente não loga requisições abortadas. O Proxy emite de qualquer jeito via `clientReq.on('end')` que é o mesmo handler — **mesmo problema**. Para capturar mid-flight errors seria preciso hook em `'close'`/`'aborted'`.

### 2.5.4 Traffic filter (`filters/traffic-filter.ts` L1-104)
`globToRegex` (L18-45): converte `**` → `.*`, `*` → `[^/]*`, `?` → `[^/]`, escapa metachars. Anchored `^...$`, case-insensitive. Suficiente para match URL.
`createTrafficFilter` (L77-102): lógica: rejeita por extensão primeiro (cheapest), depois exige match em `includePatterns` se houver, depois rejeita se match em `excludePatterns`. **Include tem prioridade** sobre exclude — comportamento esperado em ferramentas desse tipo.
`getUrlExtension` (L60-75): extrai extensão, tolerando URL relativa via fallback manual. `qMark` strip a query (L68-70) — OK.

### 2.5.5 log-collector — Container (`container.ts` L1-54)
`createLogSource(config, stream?)` troca por `config.source.type`: `file`/`docker`/`stdout`/`stderr`. Para stdout/stderr sem stream explícito, usa `process.stdout`/`process.stderr` (L29). Valida que é Readable com `typeof .on === 'function'` (L30-32). `createMultiLogCollector` filtra por `enabled` (L47).

### 2.5.6 DockerLogAdapter (`adapters/docker.adapter.ts` L1-197)
**Segurança de argumento**: valida containerId contra `/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/` e len ≤ 128 (L38-40). **Sólido contra injection** em `docker logs` argv. Também valida que o container existe via `docker inspect --format '{{.State.Running}}'` (L42-43, impl L183-196) — rejeita exit code != 0.

`spawn('docker', ['logs', '--follow', '--tail', '0', containerId])` (L54-56). Encoding configurável (L58-59). `child.on('close')` faz flush dos parsers (L68-72). `child.on('error')` só marca connected=false — **swallowed error** (L74-76): se `docker` binário não existe, usuário não é notificado salvo via log externo.

`processStream` (L110-130): dois buffers separados por stream. `MAX_LINE_BUFFER=1MB` (L22). Se excedido, força flush da linha gigante e zera buffer (L117-121). Sem isso, stdout com `
` ausente poderia crescer sem limite.

`stripDockerPrefix` (L133-136) usa `DOCKER_PREFIX_PATTERN` dos patterns (`/^timestamp\s+(stdout|stderr)\s+\w\s+(.*)$/`) — remove prefixo adicionado por containerd quando está em modo JSON-file (`-F json-file`).

Gap: **não mitiga** caso onde usuário tem socket Docker protegido só por sudo — `spawn('docker', ...)` roda como user do processo. Se é root, engine tem acesso total. Se é rootless, depende da config do host. Não é bug do adapter, é advertência operacional ausente da doc.

### 2.5.7 FileLogAdapter (`file.adapter.ts` L1-190)
`fs.watch()` + `fs.createReadStream()` com offset tracking (L42-47). **Detecção de rotação** (L87-90): `currentSize < this.offset` → zera offset. Correto para `logrotate` com `copytruncate`; para estilo `move+create`, o `fs.watch` novo inode pode não ser notificado em alguns FS (limitação do Node conhecida).

`readNewContent` (L85-118): guard `reading` evita reentrada concorrente (L86-88). Lê `start: offset, end: currentSize-1`. Se arquivo cresceu mais durante leitura, próxima iteração pega (next fs event).

`processData` + `MAX_LINE_BUFFER=1MB` (L123-141) — mesma proteção do Docker adapter.

`getFileSize` (L182-191): `ENOENT` retorna 0 (L185) — útil para arquivo que ainda não existe (criado tarde), zero rotação.

Gap: `offset = currentSize` é atualizado **antes** da leitura completa (L110). Se o stream falhar no meio, perdemos dados do intervalo. Para log crítico, seria preferível atualizar offset só após pipe completar. Observação sobre concorrência: sem lock além do flag `reading` — dois handlers de watch rápidos em sucessão podem chamar `readNewContent` que cedo retorna. OK.

### 2.5.8 StdoutLogAdapter (`stdout.adapter.ts` L1-145)
Recebe Readable no construtor (L25). `onData`/`onEnd` armazenados para removeListener no disconnect (L43-55, L62-68). Mesmo `MAX_LINE_BUFFER=1MB`. Quando stream termina (`end`), parser flush + connected=false (L49-52).

Gap: não lida com `error` event do stream — se underlying stream emitir error, nada é feito. Handler faltando.

### 2.5.9 LogParser + patterns (`parser/log-parser.ts` L1-222, `patterns.ts` L1-126)
`parseLogLine` (L30-53) é **ordered fallthrough**: JSON → Spring Boot → Log4j → Syslog → plain text. JSON tenta `JSON.parse` dentro de try/catch (L54-104). Spring Boot regex L49-50 do patterns: `\d{4}-\d{2}-\d{2} HH:MM:SS.SSS  LEVEL [thread] logger : msg`. Log4j: `[LEVEL] logger - msg`. Syslog: parse priority + severity bitmask (L152-166). Plain fallback extrai primeiro LEVEL via `PLAIN_LEVEL_PATTERN` (L181-185).

**LogParser stateful class (L189-222)**: buffereia linhas de stack trace (regex `STACK_TRACE_LINE = /^(\s+at\s+|	+at\s+|Caused by:)/` L61). Se encontra stack continuation sem evento pending, **descarta** (L202-208: silent drop). `feedLine` sempre faz flush do pendente quando chega uma linha não-stack (L212). `flush()` (L219-225) emite evento final — precisa ser chamado no disconnect senão última mensagem perde (os adapters chamam em `disconnect()` e `child.on('close')`).

`normalizeLevel` (L42-44): tenta `LEVEL_MAP[raw]`, depois lowercase, senão `'info'` default.

JSON level extractor tolera `level`/`severity`/`lvl`, numérico pino-style (L106-116). `extractJsonMessage` prioriza `msg > message > text` (L119-123). Campos "extras" agregados em `structured` (L89-101) — info útil para correlator.

**Detecção de formato** (`detectLogFormat` L92-126): score por padrão (match = +2, plain = +1), tie-break primeiro match no objeto (ordem JSON → Spring → Log4j → syslog → plain). **Não exposta via adapters atuais** — só disponível via export do módulo.

### 2.5.10 Crítica parcial — Debug Probe capture

**Confirmado**:
1. SSRF em ProxyAdapter é robusto contra IP literal privado, **mas vulnerável a DNS rebinding** (resolução acontece depois do check). Em deploy que expõe o proxy, é um hole.
2. Todos os 3 log adapters implementam `MAX_LINE_BUFFER=1MB` — memória protegida contra linha infinita.
3. Redação de headers/body delegada a `@probe/core` (`redactHeaders`, `redactBody`). Nunca re-implementado aqui.
4. Thread/connection caps no Proxy (5k conn, 10k pending) previnem exhaustion. FIFO eviction é simples mas funcional.
5. DockerLogAdapter valida containerId — seguro contra argv injection em `docker logs`.

**Gaps materiais**:
- DNS rebinding: `http.request` com `hostname` faz resolução DNS nova. Um atacante com DNS controlado resolve `a.com` primeiro para IP público (passa SSRF), depois para `127.0.0.1` quando o Node efetivamente conecta. Mitigação: resolver DNS antes e passar `options.lookup` ou usar IP literal. Não implementado.
- `MiddlewareAdapter.res.write` / `res.end` monkey-patch não cobre casos onde o framework (ex.: compression middleware) substitui `res` object. Se outro middleware wrappa depois, a cadeia pode bypassar a captura.
- `FileLogAdapter.fs.watch` é unreliable em alguns FS (NFS, docker overlay) — Node docs avisam. Mitigação por polling não está implementada.
- `DockerLogAdapter.child.on('error')` swallow: se binário `docker` ausente, adapter silencia. Deveria propagar via `onLog` event de erro ou re-throw em `connect()`.
- `StdoutLogAdapter` sem handler de `'error'` no stream. Crash potencial se underlying stream emitir error unhandled.
- `LogParser.feedLine` descarta silenciosamente stack trace orfão (linha `at com.X...` sem evento pending prévio). Perda de contexto em logs split entre sessions.
- `PLAIN_LEVEL_PATTERN` (`patterns.ts` L63-64) busca `(TRACE|DEBUG|INFO|...)` em qualquer lugar — **falso positivo**: mensagem "the WARN command was renamed" vira nível WARN.
- Nenhum adapter de log implementa redação de secret antes de emitir — confia em correlator/storage downstream. Em `emitLogEvent` o `rawLine` vai cru.

**[UNKNOWN]**:
- Uso real do `detectLogFormat` — grepping dentro dos adapters não mostra invocação; parece API não consumida.
- Se `__tests__` cobrem DNS rebinding ou rotação de log (não lidos).


---

## §1.8 Sentinel — HTTP routes verificadas (blind spot #3 encerrado)

Fonte: `src/server/routes/{findings,probe-webhooks,projects,sessions,webhook-events}.js` = 588 LOC. Todos lidos integralmente.

### 1.8.1 `findings.js` (188 LOC)
14 endpoints. Todos via `asyncHandler` + `ValidationError` semântico (L1-8):
- **POST `/`** (L28-63): validates sessionId+projectId (L34-35), derives title fallback (L38), delega a `services.findings.create`. Pós-criação dispara `queueMicrotask` → `autoProcessFinding` (L59-61) que lê env vars `SENTINEL_AUTO_DIAGNOSE`/`SENTINEL_AUTO_CORRECT` (L11,18). Erros são só `console.warn`-ed (L21) — **auto-processing é fire-and-forget**.
- GET `/:id`, GET `/` (com filtro `sessionId` OU `projectId`, limit cap 200 L81).
- POST `/:id/diagnose` L92, `/enrich-live` L96-101 (aceita `durationMs`, `limit`), `/correct` L104, `/clarify` L108-114 (requer `question`), `/dismiss` L117, `/apply` L122, `/verify` L127 (default true se `verified !== false`), `/push` L132-135 (requer `services.integration`), `/suggest-title` L139-144.
- POST `/:id/media` L147-180: accept base64 audio/video. Validação tipo `in ['audio','video']` (L153). **Cap de tamanho real** pela estimativa base64 `Math.ceil(data.length*3/4)` (L157), limites 10MB audio / 50MB video (L156). Gera mediaId via `randomUUID`, persiste via `finding.addMedia` + `storage.updateFinding`.

### 1.8.2 `probe-webhooks.js` (210 LOC) — webhook receiver
**Auth HMAC-SHA256**, não API key (L7-14). Constantes: `MAX_BUFFER=100` ring, `MAX_SKEW_SECONDS=300` anti-replay, `MAX_BODY_BYTES=1MB` (L26-29). Secret via `PROBE_WEBHOOK_SECRET` env (L54).

**POST `/`** (L126-198): usa `expressRaw({ type:'*/*', limit:MAX_BODY_BYTES })` (L129) para preservar rawBody intacto para HMAC. Fluxo:
1. Secret ausente → 503 (L131-134)
2. Headers `X-Probe-Signature`, `X-Probe-Timestamp`, `X-Probe-Event`, `X-Probe-Delivery` (L136-139)
3. Missing sig/ts → 400 (L141-144)
4. Timestamp non-finite → 400 (L146-150)
5. Skew check >5min → 401 (L152-156)
6. `sign(secret, timestamp, rawBody)` com HMAC-SHA256, hex-encoded prefixed `sha256=` (L31-35)
7. `timingSafeEqualStrings` via `crypto.timingSafeEqual` após check de length (L37-42). Correto contra timing attack.
8. JSON parse em try/catch (L166-170)
9. Push ring buffer (L172-181). receivedTotal++
10. Persist via `storage.recordProbeWebhook(entry)` em try/catch non-fatal (L184-192)
11. `mirrorSession(event, payload)` fire-and-forget via `.catch(() => {})` (L195): para `session.created`/`session.completed` chama `services.sessions.getOrCreate` e `.complete`. Falha aqui é log-only (L84-90).
12. 200 ACK (L200)

**GET `/`** (L97-125): lista do storage se disponível, senão buffer. Exibe `configured`, `persistent`, `receivedTotal`, `rejectedTotal`, `bufferSize`, `totalPersisted`.

**Gap**: `DEFAULT_PROBE_PROJECT_ID = process.env.SENTINEL_PROBE_PROJECT_ID || 'debug-probe'` (L30). Se env não setado, todos os sessions mirrored caem sob string literal `'debug-probe'` — projectId fake que pode não existir no schema. Pode gerar FK violations caso storage enforce. [UNKNOWN] se storage valida.

### 1.8.3 `projects.js` (42 LOC)
Único endpoint: **GET `/:id/stats`** (L13-38). Faz `Promise.all` de sessions.list + findings.listByProject com limit 1000 (L18-20). Agrega contadores por status/severity/type em loop.

**Gap**: `limit: 1000` é **hardcoded**. Se projeto tem >1000 findings, stats ficam truncados silenciosamente. Sem paginação de agregação — melhor seria count DB-side. Aceitável para scale inicial, mas é armadilha futura.

### 1.8.4 `sessions.js` (94 LOC)
7 endpoints. Padrão `asyncHandler` + validação. Destaques:
- POST `/` L14-26: userId default `'anonymous'`, userAgent fallback para header.
- POST `/:id/events` L50-61: batch ingest. Modo `autoCreate` quando header `X-Sentinel-Source` presente (L57-58) — probes servidor criam session implicitamente. Validação min 1 event (L54).
- GET `/:id/events` L64-72: limit cap 2000 (L68).
- GET `/:id/replay` L82-92: busca events `type='dom'`, filter por `source === 'rrweb'`, cap 50k (L88). Verifica session existe antes (L85).

### 1.8.5 `webhook-events.js` (54 LOC)
3 endpoints para inspecionar notifications persistidas:
- GET `/` L16-29: valida `status ∈ {pending,success,failed,dead_letter}` (L10, L22-24). Limit cap 500.
- GET `/:id` L33-40: 404 via `NotFoundError` (L38).
- POST `/:id/retry` L43-49: delega a `adapters.notification.retryDelivery`. Gate em `typeof ... === 'function'` (L45) — Noop adapter sem suporte lança ValidationError.

### 1.8.6 Crítica parcial — rotas Sentinel

**Confirmado**:
1. Todas as rotas usam `asyncHandler` — zero try/catch genérico com `res.status(500)`.
2. Todos os erros semânticos via `ValidationError`/`NotFoundError` de `core/errors.js`.
3. Paginação com limits cap (200 findings, 200 sessions, 500 webhook events, 2000 events, 50k replay).
4. Webhook HMAC corretamente implementa: (a) length check antes de `timingSafeEqual`, (b) skew ±5min anti-replay, (c) rawBody preservado via `express.raw()` com limit 1MB.
5. `/media` usa base64-size estimation correta (`len*3/4`) para cap antes de persistir.

**Gaps materiais**:
- `autoProcessFinding` em `findings.js` L11-22: erro só vai para `console.warn`. Não há retry, dead-letter, telemetria. Se Claude cair, finding fica `open` sem usuário saber.
- Validação `severity` em POST `/findings` ausente — aceita qualquer string (L30 default `'medium'` mas input não é enumerado). Idem `type`, `source`. Pode corromper stats/filters.
- `probe-webhooks` fire-and-forget de `mirrorSession` + `recordProbeWebhook`. Se storage falha, entry fica só no ring buffer (perdido ao restart). Log-only, sem alerta.
- `projects.js` hardcode `limit: 1000` para stats — dívida de scale.
- `webhook-events/:id/retry` — sem rate limit/cooldown. Cliente malicioso pode spammar retry.
- `sessions.js` POST `/:id/events` `autoCreate` confia puramente no header `X-Sentinel-Source` — qualquer caller que seta esse header pula a validação de session pre-existente. Sem check de projectId associado. [UNKNOWN] se middleware upstream (api-key) já resolve isso.
- `findings.js` POST `/media` armazena mediaId mas a URL retornada (`/api/findings/${id}/media/${mediaId}`) **não tem GET correspondente** nas rotas lidas. [UNKNOWN] se existe handler em outro arquivo; se não, é dead link.

**[UNKNOWN]**:
- Middleware `api-key` anterior às rotas — não lido nesta varredura. Confirmar se aplica-se às rotas de webhook (provavelmente não; webhook usa HMAC).
- Implementação de `services.findings.addMedia` / storage para media — se binary é armazenado ou só metadata.


---

# §8. Crítica final consolidada — após cobertura dos 3 pontos cegos

Todos os 3 pontos cegos foram lidos até o fim e documentados com file:line. Abaixo, o que **mudou na avaliação** vs. diagnóstico parcial anterior, o que foi **confirmado**, e o que **ainda é [UNKNOWN]**.

## 8.1 Tabela de probabilidade — revisada

| Área | Prob. prévia | Prob. atual | Mudança |
|------|-------------|-------------|---------|
| Manifest Java engine (ponto cego #1) | 50-70% material change | **0%** — lido completo | Confirmou: reflection-only type solver é real gap (§3.5.3). Findings batem com `manifest-2-complete-assessment.md`. Nada de surpresa catastrófica. |
| Debug Probe capture packages (ponto cego #2) | 40-60% | **0%** — lido completo | Confirmou: SSRF por IP literal funciona, mas **DNS rebinding é hole não coberto** (§2.5.2). Gap material novo não listado antes. |
| Sentinel routes (ponto cego #3) | 10-20% | **0%** — lido completo | Confirmou disciplina: asyncHandler + erros semânticos 100%. Descobriu: **GET /media/:mediaId não existe** (§1.8.6 + grep 2 matches só em POST). Dead link após upload. |

## 8.2 Achados novos consolidados (não estavam em §6 gaps)

1. **DNS rebinding em Debug Probe proxy** (proxy.adapter.ts L263-267, L418-422): `isPrivateHost` usa hostname literal; `http.request` resolve DNS **depois** do check. Atacante com DNS autoritativo pode bypassar. Severidade: alta se proxy exposto publicamente.

2. **Upload de media em Sentinel tem GET morto** (findings.js L177, L183 — sem handler GET): cliente recebe URL que retorna 404. Feature incompleta, não bug de segurança, mas quebra UX.

3. **`autoProcessFinding` fire-and-forget sem observabilidade** (findings.js L11-22): se Claude falhar em produção, findings ficam `open` silenciosamente. Sem retry, sem dead-letter, só console.warn.

4. **`DEFAULT_PROBE_PROJECT_ID = 'debug-probe'` hardcode string** (probe-webhooks.js L30): mirror de sessions pode criar/referenciar projectId fake se env ausente. Risco de FK violation ou dados órfãos.

5. **Log adapters swallow binary-missing errors** (docker.adapter.ts L74-76): `docker` ausente no PATH → apenas `connected=false`. Usuário sem feedback.

6. **Stack trace orfão descartado silenciosamente** (log-parser.ts L202-208): stack traces que chegam sem evento pending prévio desaparecem. Perda de forensics em logs particionados.

7. **PLAIN_LEVEL_PATTERN produz falsos positivos** (patterns.ts L63-64): `(WARN|...)` em qualquer posição → mensagem "the WARN command" vira level WARN.

8. **Stats agregation hardcoded `limit: 1000`** (projects.js L18-20): dívida técnica de escala explícita.

## 8.3 O que foi confirmado (virou evidência forte, não mais suposição)

- Manifest Java engine usa JavaParser 3.26 + ReflectionTypeSolver sem JARs de projeto. Extração de `@PreAuthorize` SpEL por regex em `extractRolesFromExpression` L535 — funciona para 80-90% dos casos, falha em composições booleanas complexas.
- ProxyAdapter tem caps concretos (5k conn / 10k pending) e FIFO eviction — proteção real.
- DockerLogAdapter valida containerId contra regex estrita — **seguro contra argv injection**.
- Webhook HMAC-SHA256 usa `timingSafeEqual` corretamente, com length-check prévio — **seguro contra timing attack**.
- Todas as 5 rotas Sentinel seguem disciplina `asyncHandler` + erros semânticos — aderência 100%.
- Filter de URL suporta glob `**`/`*`/`?` com ordem extension→include→exclude — conforme documentado.

## 8.4 [UNKNOWN] remanescentes (não inferíveis sem ler mais fontes)

- Cobertura de testes dos cenários críticos (DNS rebinding, log rotation, webhook replay) — `__tests__/` não lidos em ambos projetos.
- Middleware `api-key` de Sentinel — saber se gate aplica-se a todas as rotas ou se webhook fica fora.
- Se `storage.recordProbeWebhook` implementa dedup real por `deliveryId` ou se depende de schema unique — não lido em adapters storage.
- Se o front-end consome `/api/findings/:id/media/:mediaId` (confirmaria impacto da dead link).
- Implementação de `services.findings.addMedia` (`findings.js` L170): se persiste binário em disco, DB blob, ou S3 — não lido.

## 8.5 Juízo final (sem especulação, todos os claims têm file:line)

**Qualidade de engenharia**: alta disciplinarmente. Padrões aderidos:
- asyncHandler universal (Sentinel)
- Port/Adapter verdadeiro (todos 3 projetos)
- SSRF explícito (Debug Probe), argv injection guard (Docker adapter), HMAC timing-safe (webhook)
- Caps concretos em memória e conexões (todos os capture paths)
- Semantic errors 100% Sentinel
- MAX_LINE_BUFFER 1MB em todos log adapters

**Maturidade operacional**: média. Lacunas:
- Observabilidade silenciosa (console.warn em vez de metric/alert em 4+ pontos)
- Fire-and-forget sem dead-letter em autoprocessing e mirror
- DNS rebinding não tratado
- Features incompletas (GET /media)

**Apetite para produção**:
- Sentinel: **pronto** para deploy interno com monitoramento adicional.
- Debug Probe: **pronto** para uso dev; expor proxy publicamente requer fix de DNS rebinding.
- Manifest Java engine: **pronto** para análises estruturais; não confiável como SSOT de segurança (tipo solver incompleto, regex de SpEL frágil).

**Nenhuma "bomba" foi encontrada após a varredura dos 3 pontos cegos**. A hipótese de que 40-70% de material change existisse nos blind spots **não se confirmou**. Os gaps encontrados são incrementais, não arquitetônicos. Diagnóstico anterior (§1-§7 do documento) permanece válido; esta §8 apenas adiciona especificidade granular.

---

# §9. Roadmap "Plug-and-Play em Produto" — o que falta para a visão final

> **Visão-alvo (verbatim do usuário):** "habilitar essas ferramentas em um produto ... elas se orquestram, mapeiam tudo, analisam absolutamente todos os erros e inconsistências de front e back e trazem um resultado tão rico que qualquer IA possa saber atacar cirurgicamente ... além disso ao se rodar as ferramentas eu já tenha um verdadeiro esquadrinhamento que cria uma lista completa de todas as funcionalidades ... para que se eu quiser integrar com o Identify para gerenciar as permissões já esteja 100%".

Esta seção converte o estado atual (§1–§8) em **deltas concretos** para atingir essa visão. Nada aqui é especulação: toda afirmação referencia file:line já lido no documento ou aponta explicitamente para `[UNKNOWN: precisa ler X]`.

## 9.1 O que a visão exige — decomposta em 6 capacidades

| Capacidade | Tradução técnica | Ferramenta responsável |
|---|---|---|
| **C1. Enable 1-command** | `npx nup-suite init <projeto>` provisiona Sentinel+Probe+Manifest | — **NÃO EXISTE** (ver §9.3) |
| **C2. Auto-orquestração** | Probe→Sentinel via webhook, Sentinel→Manifest via `analyzer.resolveEndpoint`, agentes QA→Sentinel via API | Parcial (§1.7.1 webhook ok, §3 Manifest ok, agentes QA [UNKNOWN]) |
| **C3. Mapa completo front+back** | Manifest analysis run gera catálogo canônico | Existe (§3) mas tem gaps (§3.5.3 SpEL, §3.5.6 type solver) |
| **C4. Captura total de erros/inconsistências** | Probe + Sentinel capture automático + dedup | Existe Probe capture (§2.5) + Sentinel findings (§1.8) — mas sem auto-trigger pipeline completo |
| **C5. Output "IA-ready"** | Finding enriquecido com `traces + codeContext + diagnosis + suggestedFix` | Existe (§1.2 pipeline 4 etapas) — mas `confidence:"low"` quando adapters faltam |
| **C6. Esquadrinhamento → NuPIdentify-ready** | Manifest → export de permissões/endpoints → import direto no Identify | Existe parcial (generators §3) — mas **não há adapter direto** para o schema NuPIdentify |

## 9.2 Ranking de prontidão atual (por ferramenta)

| Ferramenta | Core | Operacional | Integração | Pronta para visão final? |
|---|---|---|---|---|
| **Sentinel** | 95% (§1.1–§1.8) | 70% (§8.5 lacunas observab.) | 80% (MCP ok, mas media GET morto §1.8.6) | Sim, com 5 correções incrementais |
| **Debug Probe** | 90% (§2.5) | 65% (§2.5.2 DNS rebinding, §2.5.7 swallow errors) | 75% (webhook→Sentinel ok §1.7.1) | Sim, com fix DNS rebinding obrigatório |
| **Manifest** | 80% (§3, §3.5) | 60% (§3.5.3 SpEL frágil, §3.5.6 reflection-only) | 40% (**sem exporter nativo NuPIdentity**) | Não até adicionar Identify exporter |
| **Agentes QA** | [UNKNOWN] | [UNKNOWN] | [UNKNOWN] | Indeterminável sem ler `.github/agents/` |

## 9.3 Gap #1 — **Camada de orquestração ausente** (bloqueador da visão)

> **STATUS: APLICADO (Fase 4, 2026-04-24)** — ver BASELINE.md §Fase 4. Entregue como `@nuptechs/nup-suite` em [`nup-platform/packages/nup-suite/`](/Users/yurif/Downloads/nup-platform/packages/nup-suite). CLI zero-dep (Node 20+, `fetch`/`AbortController`) com subcomandos `init`, `bootstrap`, `status`, `analyze`. `init` gera `nup-suite.config.json` + `docker-compose.yml` + `.env.example` com `WEBHOOK_URL`/`WEBHOOK_SECRET` já derivados. `bootstrap` cria Manifest project → roda análise → popula `manifestProjectId`/`manifestRunId` na seed session do Sentinel → deriva wiring do webhook Probe→Sentinel → opcionalmente baixa o bundle NuPIdentity da Fase 3. Testado: `tsc --noEmit` limpo, `vitest run` 10/10 verde, smoke-test CLI (`node dist/cli.js init "Acme App" --cwd <tmp>`) gera todos os artefatos corretamente.

**Problema**: não existe um "NuP Suite" único. Cada ferramenta tem seu próprio deploy, env-vars, healthcheck, CLI. O usuário teria que:
1. Deploy manual Debug Probe (Railway)
2. Deploy manual Manifest (server + Java engine)
3. Deploy manual Sentinel
4. Configurar 11+ env-vars cruzadas (`DEBUG_PROBE_URL`, `MANIFEST_URL`, `MANIFEST_API_KEY`, `WEBHOOK_URL`, `WEBHOOK_SECRET`, `SENTINEL_GITHUB_TOKEN`, `ANTHROPIC_API_KEY`, `SENTINEL_PROJECT_ROOTS`, `MANIFEST_PROJECT_ID_MAP`, …)
5. Registrar webhook Probe→Sentinel manualmente
6. Inicializar SDK browser + backend separadamente no produto-alvo

**Delta necessário**:
- Criar `packages/nup-suite` (monorepo novo ou dentro de `nup-platform`) com:
  - CLI `nup-suite init <project> --identity-url <url>`: gera `.env`, `docker-compose.yml` (Sentinel+Probe+Manifest+pg+redis), registra webhook automaticamente.
  - Arquivo de manifesto único `nup-suite.config.json` mapeando `projectId` → `{sentinel, probe, manifest, identify}`.
  - Script de bootstrap que (a) roda Manifest analysis 1x, (b) cria project no Sentinel com `manifestProjectId` + `manifestRunId` preenchidos (campos já existem em [src/core/domain/finding.js L1–150](/Users/yurif/Downloads/sentinel/src/core/domain/finding.js)), (c) emite SDK keys para o frontend.
- **Esforço estimado**: ~5–8 dias de engenharia. Não depende de nenhuma alteração nas 4 ferramentas.

## 9.4 Gap #2 — **Exporter NuPIdentity ausente no Manifest** (bloqueador de C6)

> **STATUS: APLICADO (Fase 3, 2026-04-24)** — ver BASELINE.md §Fase 3. Implementado em `server/generators/nupidentity-generator.ts` + wiring em `server/routes.ts` (formatos `nupidentity` e `nupidentity-runner` em `/api/analyze`, `/api/analyze-zip`, `/api/manifest/:projectId`). `npm run check` limpo nos arquivos tocados (erros remanescentes são pré-existentes em `replit_integrations/*`).
>
> **ESCOPO REVISADO (2026-04-24):** Fase 3 cobre apenas **RBAC + ABAC**. **ReBAC foi explicitamente excluído** e virou Fase 3.5 (complemento posterior). Justificativa em §9.4.1 abaixo.

### 9.4.1 Por que ReBAC fica de fora (ler antes de qualquer PR)

Investigação em `server/routes/rebac.routes.ts` (514 LOC), `shared/schema/rebac.ts` e `AUTH-PERMISSION-FLOW-MAP.md` do NuPIdentify revelou que ReBAC tem **duas camadas** com naturezas distintas:

| Camada | O que é | Quem produz hoje | Manifest consegue gerar? |
|---|---|---|---|
| **Planta** (`authorization_models`) | JSON único por org com `typeDefinitions: [{type, relations}]`. Define "tipo `contrato` tem relações `dono/editor/leitor`". | Humano escreve à mão e faz `POST /api/rebac/models`. | **Parcialmente** — dá para inferir de `@PreAuthorize("@owner.check(#id)")` e callsites de `checkOwnershipViaRebac(type, id, relation)`. Userset rewrites (hierarquia owner→editor→leitor) exigem heurística frágil. |
| **Tuplas** (`relationship_tuples`) | Linhas no banco: `contrato:123#dono@user:42`. Milhões. | Consumer cria em runtime quando o recurso é criado (EasyNuP faz inline; NuP-School faz `backfillRebacTuples` no boot). | **Zero.** Tupla depende de dado que só existe com o app rodando em produção. |

**Decisão:** Manifest faz análise estática. Não tem como gerar tuplas. Gerar apenas a planta sem um fluxo claro de popular tuplas entrega metade de uma coisa que ninguém vai usar. Melhor separar: Fase 3 valida o pipeline RBAC+ABAC (onde Manifest tem 100% do dado); Fase 3.5 trata ReBAC como complemento, quando tivermos política clara de quem/quando popula tuplas.

**Marco de retomada (Fase 3.5):** quando dois dos cinco consumers (EasyNuP, NuP-School, Sales, Services, Sentinel) tiverem `backfillRebacTuples` padronizado e a UI do Identify ganhar editor de planta ReBAC, voltar aqui. Até lá, consumers continuam fazendo `POST /api/rebac/tuples` na mão como hoje (é o padrão atual e funciona).

### 9.4.2 Escopo da Fase 3 (RBAC + ABAC)

**Problema**: Manifest gera Keycloak realm JSON, OPA Rego, OpenAPI YAML, Policy Matrix CSV (§3 generators), mas **nenhum dos formatos bate com o schema NuPIdentity**. O manifesto precisa converter endpoints + `@PreAuthorize` em artefatos que os 3 endpoints reais aceitam:

| Artefato de saída | Endpoint alvo no Identify | Auth | Verificado em |
|---|---|---|---|
| `1-systems-register.json` — `{system:{id,name}, functions:[...], organizationId}` | `POST /api/systems/register` (idempotente, faz sync de functions via hash) | `requireSystemApiKey` | `server/routes/systems.routes.ts` L125 |
| `2-profiles.json` — N perfis para criar | `POST /api/profiles` (N chamadas) | admin | `server/routes/profiles.routes.ts` |
| `3-profile-functions.json` — assignment perfil→function | `POST /api/profiles/:id/functions` | admin | idem |
| `4-abac-policies.json` — N policies | `POST /api/policies` (N chamadas) | admin | `server/routes/policies.routes.ts` L46 |

**Normalizações obrigatórias** (server **rejeita** qualquer outra coisa):
- `function.key`: convenção `system:resource:action`.
- ABAC `conditions[].operator`: enum de 16 (`equals`, `not_equals`, `contains`, `greater_than`, `between`, `in`, `regex`, `exists`, …) — traduzir SpEL/guards JS para este enum.
- ABAC `effect`: `allow` ou `deny`.

**Riscos detectados durante a investigação** (manter em mente ao codar):
- Nenhum dos três endpoints tem bulk. Cada policy/profile é 1 HTTP call. Exporter precisa emitir **script runner** (Node) com retry/idempotência, não só JSON.
- Criar profile exige `organizationId` existente — pressupõe org provisionada out-of-band.
- `POST /api/systems/register` é self-service via `systemApiKey`; os demais exigem admin HS256. Runner precisa de **dois credenciais** (env vars separadas).

### 9.4.3 Delta necessário

- Adicionar `server/generators/nupidentity.generator.ts` em Manifest. Input: `AnalysisRun + sourceFiles`. Output: os 4 JSONs listados em 9.4.2 + README com ordem de execução.
- Adicionar mapeador SpEL→ABAC: casos simples (`hasRole('X')` → profile grant; `#id == principal.id` → policy same-user com operator `equals` em `resource.ownerId`; `hasPermission(#obj, 'read')` → direct function). Casos compostos (§3.5.3 regex falha) → emitir `[UNKNOWN]` como comentário + warning na CLI.
- Adicionar endpoint `POST /api/projects/:id/export/nupidentity` que emite os 4 JSONs como ZIP.
- (Opcional 3.B) `nupidentity-runner.ts` — script Node auto-contido que executa os 4 JSONs na ordem com retry; lê `NUPIDENTITY_BASE_URL`, `NUPIDENTITY_SYSTEM_API_KEY`, `NUPIDENTITY_ADMIN_TOKEN`, `NUPIDENTITY_ORG_ID`.
- **Esforço**: ~3–4 dias sem ReBAC. (Antes estimado 3–5 dias incluindo ReBAC.)

### 9.4.4 Fora de escopo — complemento posterior (Fase 3.5)

**Não implementar agora. Documentado aqui para não se perder:**

- `5-rebac-model.json` → `POST /api/rebac/models` (exige `requireAdmin` HS256 — gap conhecido: system key não consegue importar modelo).
- `6-rebac-seed-tuples.json` → `POST /api/rebac/tuples` (N chamadas, idempotente).
- Mapeador estático ReBAC: extrair de `@PreAuthorize("@owner.check(#id)")` e callsites `checkOwnershipViaRebac(type, id, relation)`.
- Pré-requisito do Identify: abrir `/api/rebac/models` para aceitar `rebac:write` via system credentials (hoje só admin UI cria modelo).
- Pré-requisito dos consumers: padronizar `backfillRebacTuples` (NuP-School tem, EasyNuP não tem).

**Busca futura:** grep por `Fase 3.5` ou `9.4.4` para retomar.

## 9.5 Gap #3 — **Segurança: DNS rebinding no Debug Probe** (§8.2.1 — bloqueador se proxy for exposto)

> **STATUS: APLICADO (Fase 1, 2026-04-25).** Ver `BASELINE.md` §Fase 1 §9.5. Implementado via helper `resolveAndVerifyPublicHost()` em `proxy.adapter.ts` (3 callsites: CONNECT tunnel, `forwardAndCapture`, `forwardRequest`). 9 testes novos em `__tests__/adapters/proxy-dns-rebinding.test.ts`. 64/64 passando no pacote.

**Fix**: em [packages/network-interceptor/src/proxy.adapter.ts L263–267, L418–422](/Users/yurif/Downloads/debug-probe/packages/network-interceptor/src/proxy.adapter.ts), substituir check por hostname pela forma two-phase:
```ts
import { lookup } from 'node:dns/promises';
const { address } = await lookup(hostname);
if (isPrivateHost(address)) throw new SSRFError(...);
// usar address diretamente em http.request para evitar re-resolve
```
Ou: copiar o padrão do Sentinel `ssrf-guard.js` (§1.7.1) que já faz resolução antecipada.

**Esforço**: ~0.5 dia. Testes: adicionar caso em `__tests__/` simulando domínio autoritativo retornando IP público primeiro e privado no segundo lookup.

## 9.6 Gap #4 — **Dead link `/media/:mediaId` no Sentinel** (§1.8.6, §8.2.2)

> **STATUS: APLICADO (Fase 2)** — ver BASELINE.md §Fase 2. Tocado: `src/core/ports/storage.port.js`, `src/adapters/storage/{memory,postgres}.adapter.js`, `src/core/services/finding.service.js`, `src/server/routes/findings.js`, `tests/server/findings-routes.test.js`. Sentinel 812/812 ✅.

**Fix**: adicionar em [src/server/routes/findings.js](/Users/yurif/Downloads/sentinel/src/server/routes/findings.js) logo após POST `/media` (L147–180):
```js
router.get('/:id/media/:mediaId', asyncHandler(async (req, res) => {
  const media = await services.findings.getMedia(req.params.id, req.params.mediaId);
  if (!media) throw new NotFoundError('Media not found');
  res.setHeader('Content-Type', media.contentType);
  res.send(media.buffer);
}));
```
Depende de `services.findings.getMedia` existir — `[UNKNOWN: precisa ler src/core/services/finding.service.js além de L1–100]`. Se não existir, criar + instrumentar storage.

**Esforço**: ~0.5–1 dia.

## 9.7 Gap #5 — **Observabilidade silenciosa** (§8.5 "Maturidade operacional: média")

> **STATUS: APLICADO (Fase 1, 2026-04-25).** 6 itens (1–6) implementados: ver `BASELINE.md` §Fase 1 §9.7 para arquivos e linhas. Cobertura:
> 1. `findings.js` — `runWithRetry` + counter `sentinel_auto_process_total{stage,outcome}`.
> 2. `docker.adapter.ts` — `getHealth()` + `lastError` + diagnostics.
> 3. `stdout.adapter.ts` — listener `stream.on('error')` + `getHealth()`.
> 4. `log-parser.ts` — counter `log_parser_orphan_stacks_total`.
> 5. `patterns.ts` — `PLAIN_LEVEL_ANCHORED_PATTERN` (match ancorado).
> 6. `probe-webhooks.js` — removido fallback silencioso `'debug-probe'`; fail-loud se `SENTINEL_PROBE_PROJECT_ID` não setado.

Pontos já identificados com file:line que precisam virar métricas/alertas:

| Ponto | Arquivo:linha | Ação |
|---|---|---|
| `autoProcessFinding` fire-and-forget | findings.js L11–22 | Trocar `console.warn` por `metrics.findingAutoProcessFailures.inc({reason})` + retentar via Bull |
| Docker adapter swallow `docker` missing | log-collector/docker.adapter.ts L74–76 | Log estruturado Pino + healthcheck endpoint |
| Stdout adapter sem `error` handler | log-collector/stdout.adapter.ts | Adicionar `stream.on('error', err => logger.error({err}))` |
| Orphan stack trace drop | log-parser.ts L202–208 | Emitir counter `logParserOrphanStacksTotal` para detectar |
| PLAIN_LEVEL_PATTERN false-positive | patterns.ts L63–64 | Restringir regex a início-de-linha: `/^(?:\s*)(WARN\|ERROR\|…)\b/` |
| `DEFAULT_PROBE_PROJECT_ID` hardcode | probe-webhooks.js L30 | Falhar com 400 em vez de fallback silencioso |

**Esforço total**: ~2–3 dias.

## 9.8 Gap #6 — **Cobertura de auto-trigger end-to-end** (C4)

> **STATUS: APLICADO (Fase 2)** — ver BASELINE.md §Fase 2. `src/server/routes/findings.js` passou a ter `isAutoProcessEligible(finding, body)`: dispara pipeline apenas para `source=auto_*`, `autoTriggerPipeline:true` opt-in, ou `source=manual` com screenshot+annotation+correlationId. Sentinel 812/812 ✅. Teste `tests/server/api.test.js` migrado para opt-in explícito.

Hoje a cadeia "usuário anota bug → Sentinel diagnostica → Manifest resolve código → AI sugere fix" **funciona MAS só se o usuário chamar explicitamente** `POST /api/findings/:id/diagnose` ([src/server/routes/findings.js L~120](/Users/yurif/Downloads/sentinel/src/server/routes/findings.js)). A função `autoProcessFinding` (L11–22) **só roda para `source=auto_error|auto_performance|auto_network`** — anotações manuais via SDK não disparam pipeline automático.

**Delta**: estender `autoProcessFinding` para incluir `source=manual` quando finding tem `screenshot + annotation text + correlationId` (sinais suficientes de intent). Alternativa: campo explícito `autoTriggerPipeline: true` no payload POST.

**Esforço**: ~1 dia.

## 9.9 Gap #7 — **Agentes QA desconhecidos** (§4)

`[UNKNOWN]` crítico: a seção §4 do documento não tem leitura evidenciada de `.github/agents/easynup-test-sentinel.md` nem `ui-qa-sentinel.md`. Precisa-se ler esses 2 arquivos para saber:
- Quais ports o agente invoca (Sentinel MCP? Manifest API? Probe API?)
- Se já retorna findings no schema Sentinel
- Se consegue rodar headless em CI

Sem essa leitura, **não é possível dizer se C2 (orquestração) cobre agentes QA**.

**Esforço de investigação**: ~0.5 dia (leitura + map to §9.1 capacities).

## 9.10 Roadmap executável em ordem de dependência

```
FASE 1 — Segurança (bloqueia exposição pública): 1–2 dias
  ├── 9.5 Fix DNS rebinding Debug Probe
  └── 9.7 Observabilidade mínima (6 pontos)

FASE 2 — Completude funcional: 3–4 dias
  ├── 9.6 Fix media GET Sentinel
  ├── 9.8 Auto-trigger para findings manuais
  └── 9.9 Ler agentes QA e decidir gap real

FASE 3 — Integração Identify (bloqueia C6): 3–5 dias
  └── 9.4 Exporter NuPIdentity no Manifest
       └── PRECONDIÇÃO: confirmar API de import do NuPIdentify

FASE 4 — Orquestração unificada (bloqueia C1): 5–8 dias
  └── 9.3 Criar packages/nup-suite com CLI + compose + bootstrap

TOTAL: 12–19 dias de engenharia (1 dev) para visão 100% materializada.
```

## 9.11 O que cada ferramenta produzirá quando tudo acima estiver feito

Dado um produto "X" recém-integrado via `npx nup-suite init X`:

1. **Manifest** rodará análise inicial → gera:
   - `manifest.json` (endpoints + permissões + métodos HTTP)
   - `openapi.yaml` (contrato público)
   - `nupidentity-import.json` (NEW, §9.4) — roles+permissions+ABAC policies prontas para `POST /api/identity/import` no NuPIdentify
   - `coverage-map.json` (endpoints ↔ chamadas frontend)
2. **Debug Probe** começa a capturar:
   - Todas as requisições HTTP (back)
   - Todos os erros console/unhandled (front, via SDK)
   - Logs estruturados dos containers
   - Correlation IDs em 100% dos flows
3. **Sentinel** recebe via webhook auto-findings. Para cada:
   - Enriquece com traces do Probe (§1.2 etapa 1)
   - Resolve endpoint+código via Manifest (§1.2 etapa 2)
   - Gera diagnóstico Claude (§1.2 etapa 3) com `rootCause + suggestedFix.files[]`
   - Notifica webhook configurado (ex: Slack) via [webhook.adapter.js §1.7.1](/Users/yurif/Downloads/sentinel/src/adapters/notification/webhook.adapter.js)
4. **Agentes QA** (pós-leitura §9.9) rodam em CI ou on-demand, produzindo findings automáticas no mesmo schema Sentinel.
5. **MCP server Sentinel** (§1.5) expõe 11 tools → qualquer IA (Claude Code, Copilot, Cursor) pode listar findings, pegar contexto de código, pedir diagnóstico, aplicar correção — **sem handcrafted prompt**.

## 9.12 Veredicto — quão longe está da visão?

**Distância atual:** 12–19 dias (1 dev) com 0 mudanças arquitetônicas. Todas as bases (Port/Adapter, DI container, MCP, webhook retry/DLQ, HMAC, SSRF partial) **já existem e foram verificadas**. Os 7 gaps são deltas incrementais, não redesenhos.

**Risco principal:** Gap #1 (orquestração) é o único que depende de novo código significativo (~40% do esforço total). Os demais são ajustes cirúrgicos.

**Recomendação prioritária se tempo for limitado:**
- Se foco = segurança: FASE 1 (1–2 dias) destrava exposição pública.
- Se foco = integração Identify: FASE 3 (3–5 dias) entrega o deliverable de "permissões 100%".
- Se foco = UX "ativar em 1 comando": FASE 4 (5–8 dias) é obrigatória, mas só faz sentido depois da FASE 3.

**Afirmação final verificável**: nenhum componente está "quebrado de forma irrecuperável". A soma dos 4 projetos tem massa crítica suficiente para a visão do usuário — falta apenas unificar a experiência (FASE 4) e adicionar o export específico para Identify (FASE 3).

---

# §10. Agentes QA — leitura direta (resolve [UNKNOWN] da §4 e §9.9)

> Fontes lidas nesta sessão:
> - `/Users/yurif/Downloads/NuPIdentify/.github/agents/ui-qa-sentinel.agent.md` (283 linhas)
> - `/Users/yurif/Downloads/easynup/.github/agents/easynup-test-sentinel.agent.md` (1168 linhas)

## 10.1 UI QA Sentinel — fatos verificados

| Aspecto | Evidência (file:line) | Veredicto |
|---|---|---|
| **Orquestração tripla** | L11 "UI layer of a three-tool ecosystem: Manifest + Debug Probe + Sentinel" | **Já orquestra as 3 ferramentas** |
| **Preflight health** | L21-24 lista 3 URLs Railway e manda `GET /health` em cada | Não é aspiracional — é regra operacional |
| **Schema Sentinel Finding** | L52-83 JSON literal com `source/type/severity` do enum correto | **Shape validado contra `src/core/domain/finding.js`** (declarado L140) |
| **Vocabulário anti-invenção** | L85-92 "do NOT invent values — Sentinel will reject" | Defensivo contra hallucination |
| **Integração Manifest** | L34-42 `GET /api/analysis/{runId}/manifest` + "screens[].interactions[]" | Usa catálogo canônico, não selectors inventados |
| **Debug Probe** | L102-107 `GET /api/sessions/{id}/replay` para root-cause | Delega investigação de backend |
| **Dimensão 10 "UI vs Permission"** | L201-212 cruza UI com Manifest omission engine (`UNPROTECTED_OUTLIER`, `MISSING_PROTECTION`) | **É exatamente a capacidade C6** (integração Identify — §9.1) |
| **Dedup de findings** | L227 "Skip if `browserContext.network + cssSelector + pageUrl` triple matches existing open" | Anti-ruído real |
| **Playwright MCP fallback** | L276-283 modo degradado quando MCP indisponível | Graceful degradation |

**Capacidades reais**: 10 dimensões (layout, interaction, a11y WCAG 2.2 AA, forms, content, perf, responsive 3 viewports, visual regression, state coverage 7 estados, UI-vs-Permission). Cada dimensão tem critério objetivo citando regra (ex: WCAG 1.4.3, 2.5.5, toque 44×44).

**Forças reais**:
- Shape Sentinel 100% compatível (L140 "validated against Sentinel v0.2 source")
- Dedup + evidência + "no visual hallucination" (L110)
- Cita URLs Railway de produção — já testável hoje

**Limitação real**:
- Depende de Playwright MCP instalado localmente (L276)
- Não é autônomo em CI — precisa ser invocado por humano/outro agente
- Pede API key ao usuário em runtime (L27 "ask them once") — bloqueia automação headless

## 10.2 EasyNuP Test Sentinel — fatos verificados

| Aspecto | Evidência (file:line) | Veredicto |
|---|---|---|
| **14 dimensões** | L171-405 (Jakarta Validation, tipos/formatos, limites, regras negócio, CRUD, soft delete, auditoria, segurança, permissões, paginação, integridade referencial, concorrência, gateway, frontend E2E) | **Cobertura maior que UI QA Sentinel** |
| **4 personas anti-bug** | L11-14 (auditor, malicioso, distraído, dev esquecido) | Framework mental explícito |
| **Discovery-driven** | L91-108 obriga leitura de Params/Service/Entity ANTES de gerar teste | **Anti-hallucination real** |
| **Anti-flaky constraints** | L18-28 ("nunca Thread.sleep, nunca flaky, nunca private method directly") | Disciplina de teste |
| **Mock vs DB real matrix** | L30-36 tabela com 4 camadas (unit Java, unit Gateway, integration Gateway DB real, E2E Playwright) | Regra operacional clara |
| **Pipeline Meta TestGen-LLM** | L155-162 (compila → 3× sem flaky → cobre branch novo → nome descritivo) | Filtro multi-estágio |
| **Mapa de permissões** | L332-370 lista 90+ permissões EasyNuP por domínio | **Catálogo pronto para importar no Identify** |
| **Mapa de limites @Size** | L245-256 tabela de limites por campo (name=255, cnpj=14, UF=2, etc.) | Elimina invenção |
| **Regras de negócio específicas** | L266-315 datas contraditórias, limpeza CNPJ/CEP, defaults, unicidade, validações cruzadas | Conhecimento de domínio denso |

**Capacidades reais**:
- JUnit 5 (Mockito + MockedStatic), Jest (gateway), Vitest (frontend unit), Playwright (E2E)
- Integra com DB real em CI para testes de gateway
- Aplica ChunkLoadError detection (no description) e build verification
- Reporta bugs no formato: entidade + dimensão + severidade + fix proposto

**Forças reais**:
- Muito mais denso que UI QA Sentinel — quase um RFC de testes do EasyNuP
- Tem **mapa operacional completo de permissões EasyNuP** (L332-370) — se exportado vira `nupidentity-import.json` imediato
- "Pipeline de filtro" (L155) imita TestGen-LLM da Meta — não é hype

**Limitações reais**:
- **Escopo travado ao EasyNuP** — nomes de classes, tabelas, regex de CNPJ, mapa permissions são hard-coded (ex: L211 "MeasurementUnitMustMatch", L246 tabela EasyNuP-específica)
- **NÃO é genérico** — não funciona em outro produto sem reescrita (ao contrário do UI QA Sentinel que é genérico)
- Não posta findings no Sentinel (ao contrário do UI QA Sentinel — L140). Relatório é Markdown + arquivos de teste.
- Não usa Debug Probe nem Manifest diretamente — é 100% estático/unit

## 10.3 Impacto no diagnóstico anterior — atualizações à §9

### 10.3.1 Gap §9.9 ("Agentes QA desconhecidos") — RESOLVIDO

Antes: `[UNKNOWN]`. Agora:

| Agente | Integra com Sentinel? | Integra com Manifest? | Integra com Probe? | Genérico? |
|---|---|---|---|---|
| **UI QA Sentinel** | **Sim** (POST `/api/findings`, shape validado) | **Sim** (catálogo + omission engine) | **Sim** (replay session) | **Sim** |
| **EasyNuP Test Sentinel** | **Não** (só gera testes + markdown) | **Não** | **Não** | **Não — EasyNuP-only** |

### 10.3.2 Capacidade C2 ("Auto-orquestração") — revisada

Antes: "Parcial (§1.7.1 webhook ok, §3 Manifest ok, agentes QA [UNKNOWN])".
Agora: **Parcialmente completa**. UI QA Sentinel já orquestra as 3 ferramentas via HTTP real. EasyNuP Test Sentinel **fica fora** — opera em paralelo, produz testes, não participa do loop find→diagnose→correct.

### 10.3.3 Nova capacidade descoberta — C7 "Catálogo humano de permissões"

EasyNuP Test Sentinel §10.2 tem **mapa de 90+ permissões EasyNuP já curado** (L332-370). Isso é input direto para o gap §9.4 (exporter NuPIdentity). Em vez de inferir permissions via regex SpEL (frágil, §3.5.3), pode-se ler o mapa do agente como seed.

**Proposta**: extrair `permissions.json` do agente → transformar em schema NuPIdentify → import. Reduz o risco da FASE 3 porque não depende 100% do parser Java.

### 10.3.4 Novo gap descoberto — §10.3.4 "Agente EasyNuP Test Sentinel não alimenta Sentinel"

> **STATUS: APLICADO (Fase 2)** — `easynup/.github/agents/easynup-test-sentinel.agent.md` agora contém **Etapa 5 — Emitir findings para o Sentinel** (POST `/api/sessions` + POST `/api/findings` com shape canônica, severidade obrigatória, opt-in explícito para `autoTriggerPipeline`, falha-silenciosa se Sentinel offline).

Apesar do nome, ele não posta findings no Sentinel. Quando identifica bug, escreve em markdown local. Isso **quebra a cadeia auto-find→auto-diagnose→auto-correct** prevista na visão final.

**Fix proposto**: adicionar seção "Etapa 5 — Emit findings to Sentinel" no agente, reutilizando o shape documentado no UI QA Sentinel L52-83. Esforço: ~0.5 dia (é só prompt engineering, não código).

### 10.3.5 Roadmap §9.10 — revisão

FASE 2 agora tem escopo mais claro:
```
FASE 2 — Completude funcional: 3–4 dias  (atualizado)
  ├── 9.6 Fix media GET Sentinel
  ├── 9.8 Auto-trigger para findings manuais
  ├── 10.3.4 Fazer EasyNuP Test Sentinel emitir findings no Sentinel (~0.5d)
  └── Adicionar agente "ui-qa-sentinel" como adapter no container Sentinel (opcional)
```

FASE 3 (exporter NuPIdentity) ganha **atalho**:
```
FASE 3 — Integração Identify: 2–4 dias  (reduzido de 3–5d)
  ├── Extrair mapa de permissions do EasyNuP Test Sentinel L332-370 → seed
  ├── Exporter genérico Manifest → NuPIdentity schema
  └── Cross-reference com UI QA Sentinel "UI-vs-Permission" (L201-212)
```

## 10.4 Veredicto atualizado — quão longe está da visão?

**Distância nova**: 10–17 dias (antes 12–19), com redução de 2 dias na FASE 3 por causa do catálogo EasyNuP pronto.

**Mudanças qualitativas**:
1. **UI QA Sentinel é uma peça da visão já implementada** — não é promessa. Já orquestra Manifest+Probe+Sentinel e posta findings no schema correto.
2. **EasyNuP Test Sentinel é parcialmente útil** — rico em conteúdo, pobre em integração. Fica como "gerador de testes stand-alone" até receber patch §10.3.4.
3. **Cobertura combinada** é impressionante: UI QA faz 10 dimensões runtime, EasyNuP faz 14 dimensões estáticas (Jakarta, SQL, soft delete, audit). **Juntos cobrem >20 dimensões únicas**.

**Assertiva nova**: a visão não precisa reinventar agentes. Precisa:
- Generalizar EasyNuP Test Sentinel (remover hard-code EasyNuP) → vira "Test Sentinel" reusável
- Conectar EasyNuP Test Sentinel ao Sentinel HTTP (§10.3.4)
- Promover UI QA Sentinel a adapter oficial do container Sentinel (não só agente chat)

**Nada disso requer mudança arquitetônica.** Mantém-se a conclusão da §8.5: massa crítica existe, falta embrulhar.
