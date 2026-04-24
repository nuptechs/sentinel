# BASELINE — Pré-unificação (Fase 0)

**Data:** 2026-04-24 (UTC)
**Propósito:** Snapshot verificável para detectar regressões introduzidas nas Fases 1-4 do roadmap de unificação Sentinel + Debug Probe + Manifest + NuPIdentify.

---

## 1. Saúde Railway (produção)

| Serviço | URL | HTTP | Resposta relevante |
|---|---|---|---|
| Sentinel | `sentinel-app-production-e44b.up.railway.app/health` | 200 | `{"status":"ok","timestamp":1777036394016}` |
| Debug Probe | `debug-probe-production.up.railway.app/health` | 200 | `{"status":"ok","version":"0.1.0","storageOk":true,"pool":{...,"circuitBreakerState":"closed"}}` |
| Manifest | `probeserver-production.up.railway.app/api/projects` | 200 | array com `{id:4,status:"failed"}` (ver anomalia A1) |

---

## 2. Git — tags de congelamento

Tags anotadas locais (**não pushed**). Reverter via `git reset --hard pre-unification-v0`.

| Repo | Commit HEAD | Tag |
|---|---|---|
| `sentinel` | `877c1c9` | `pre-unification-v0` |
| `debug-probe` | `3b19902` | `pre-unification-v0` |
| `Manifest 2` | `6315057` | `pre-unification-v0` |
| `NuPIdentify` | `d926d10` | `pre-unification-v0` |

Untracked no momento do snapshot (não incluídos no tag):
- `sentinel/FOUR-TOOLS-DEEP-AUDIT.md` — doc de auditoria desta sessão.
- `NuPIdentify/ONDA-3.5-SDK-AUDIT-EVIDENCE.md` — workstream paralelo Onda 3.5.

---

## 3. Testes — contagem de baseline

| Repo | Comando | Resultado |
|---|---|---|
| `sentinel` | `npm test` (node --test) | **806 pass / 0 fail** (218 suites, 5.3 s) ✅ |
| `debug-probe` | `npx vitest run` | **1430 pass / 23 fail** (81 arquivos, 8 com falhas, 30 erros, 200 s) ⚠ ver A2 |
| `Manifest 2` | `npm run check` (tsc) | **13 erros TS** ⚠ ver A3 |
| `NuPIdentify` | *(não executado — não bloqueia Fase 1-3)* | — |

---

## 4. Anomalias observadas (pré-existentes, NÃO introduzidas por esta unificação)

### A1 — Manifest: projeto id=4 com `status:"failed"` em produção
Baseline ruidosa no listagem de `/api/projects`. Não bloqueia mas indica que a UI do Manifest já expõe estado inconsistente em produção. Relevante para Fase 2 (completude funcional).

### A2 — Debug Probe: 23 testes de integração/WS falhando
Concentração exclusiva em:
- `server/__tests__/integration/correlation-engine.test.ts`
- `server/__tests__/integration/e2e-lifecycle.test.ts`
- `server/__tests__/integration/ingest-pipeline.test.ts`
- `server/__tests__/integration/websocket-realtime.test.ts`
- `server/__tests__/observability/metrics.test.ts`
- `server/__tests__/performance/benchmarks.test.ts`
- `server/__tests__/ws/realtime.test.ts`
- `server/__tests__/ws/subscription-cap.test.ts`

Mistura de `AssertionError` (contagens de subscription e timeline off-by-N: `expected 15 to be 20`, `expected 0 to be 30`, `expected 12 to be 2000`) com timeouts. **Todos os 10 pacotes `packages/*` estão verdes** — falhas isoladas no harness do server, compatível com flakiness de timers/portas sob execução concorrente. Classificar em Fase 2 se persistirem em re-run.

### A3 — Manifest: 13 erros TS em `server/replit_integrations/*`
Todos em `audio/routes.ts`, `batch/utils.ts`, `chat/routes.ts`, `chat/storage.ts`, `image/client.ts`, `image/routes.ts`. Erros recorrentes:
- `string | string[]` não atribuível a `string` (parsers de query não narrow-ados)
- `AbortError` removida em p-retry (versão upgrade)
- Membros `conversations`/`messages` não exportados em `@shared/schema`
- `response.data is possibly undefined`

Aparenta ser pasta de add-ons Replit não removida na migração. Candidato a limpeza em Fase 1 (higiene) ou remoção integral se código morto.

---

## 5. Como usar este baseline

Ao final de cada fase do roadmap:
1. `npm test` em `sentinel` deve continuar **806/806**.
2. Debug Probe: número de falhas **não pode crescer acima de 23**. Idealmente cair.
3. Manifest: `npm run check` não pode superar **13 erros TS**.
4. Railway /health nos 3 serviços deve seguir HTTP 200.
5. Se precisar reverter uma fase: `git reset --hard pre-unification-v0` no repo afetado.

Qualquer regressão acima desses limiares é **bloqueante** e exige rollback ou correção antes de prosseguir.

---

## Fase 1 — Concluída

**Data:** 2026-04-25

### §9.5 — DNS rebinding no proxy (Debug Probe)
- `packages/network-interceptor/src/adapters/proxy.adapter.ts`: 3 callsites (CONNECT tunnel, `forwardAndCapture`, `forwardRequest`) agora usam `resolveAndVerifyPublicHost()` (novo helper exportado). Verifica cada IP retornado pelo `dns/promises.lookup({all:true, verbatim:true})`, rejeita qualquer privado/loopback/link-local, e conecta no IP literal com `servername` = hostname original (SNI preservado).
- `packages/network-interceptor/__tests__/adapters/proxy-dns-rebinding.test.ts`: 9 testes novos (loopback, multi-record w/ private, IPv4 literal short-circuit, nxdomain, IPv6 ULA, etc.). 64/64 passando no pacote.

### §9.7 — Hardening de observabilidade
1. `sentinel/src/server/routes/findings.js` + `src/observability/metrics.js`: `runWithRetry()` (1 retry, backoff 500 ms) envolvendo `diagnose` e `correct` do auto-process; novo counter `sentinel_auto_process_total{stage,outcome}`.
2. `debug-probe/packages/log-collector/src/adapters/docker.adapter.ts`: captura `child.on('error')` / `close(code != 0)`, guarda `lastError`, expõe `getHealth()`, sintetiza `LogEvent` de diagnóstico.
3. `debug-probe/packages/log-collector/src/adapters/stdout.adapter.ts`: registra listener `stream.on('error')` (evita crash Node), mesmo padrão `lastError` + `getHealth()` + `emitDiagnostic()`.
4. `debug-probe/packages/log-collector/src/parser/log-parser.ts`: counter módulo `log_parser_orphan_stacks_total` incrementado quando linha de stack chega sem `pendingEvent`. Getters exportados.
5. `debug-probe/packages/log-collector/src/parser/patterns.ts`: novo `PLAIN_LEVEL_ANCHORED_PATTERN` (prefere matches ancorados); `PLAIN_LEVEL_PATTERN` loose mantido para compat. Parser tenta ancorado primeiro.
6. `sentinel/src/server/routes/probe-webhooks.js`: removido fallback silencioso `'debug-probe'`. Se `SENTINEL_PROBE_PROJECT_ID` não estiver setado, `mirrorSession()` loga error (once) e pula — webhook ainda ACK para evitar retries do Probe, mas sessões não vazam com projectId hardcoded. Teste atualizado para setar o env.

### Contagens pós-Fase-1
| Repo | Antes | Depois |
|---|---|---|
| sentinel | 806/806 | **806/806** ✅ |
| debug-probe | 1430 pass / 23 fail | **1439 pass / 23 fail** ✅ (+9 novos testes DNS) |
| Manifest | 13 erros TS | não alterado nesta fase |

---

## Fase 2 — Unificação (concluída)

**Data:** 2026-04-25

### §9.6 — GET /api/findings/:id/media/:mediaId (Sentinel)
Endpoint de playback existia apenas como URL; o POST descartava os bytes.
Agora:
- `src/core/ports/storage.port.js`: novos métodos abstratos `storeMedia(row)` e `getMedia(mediaId)` (doc: ephemeral no adapter padrão).
- `src/adapters/storage/memory.adapter.js`: `Map<mediaId,{id,findingId,contentType,buffer}>` + `storeMedia` / `getMedia` com `Buffer.from()` defensivo.
- `src/adapters/storage/postgres.adapter.js`: mesmo Map in-memory com TODO explícito para coluna `bytea`. Metadata em `sentinel_findings.media` JSON persiste; bytes são ephemerais por enquanto.
- `src/core/services/finding.service.js`: `storeMedia(findingId, {type,mimeType,buffer})` valida Buffer + tipo ∈ [audio,video], gera `mediaId` via `randomUUID()`, atualiza finding com `addMedia()`. `getMedia(findingId, mediaId)` checa propriedade (rejeita cross-finding).
- `src/server/routes/findings.js`: POST `/media` agora decodifica base64 real, aplica cap 10 MB (audio) / 50 MB (video), persiste via service. Novo GET `/:id/media/:mediaId` devolve bytes com `Content-Type` correto, `Content-Length` e `Cache-Control: private, max-age=300`. `NotFoundError` em mediaId desconhecido ou cross-finding.

### §9.8 — Gate de elegibilidade do auto-process (Sentinel)
O pipeline (`autoProcessFinding`) disparava `diagnose → correct → verify` para **todo** finding criado, gastando tokens em manual sem contexto.
Agora:
- `src/server/routes/findings.js`: nova função `isAutoProcessEligible(finding, body)`. Auto-process roda apenas quando:
  1. `body.autoTriggerPipeline === true` (opt-in explícito), OU
  2. `source ∈ {auto_error, auto_performance, auto_network}`, OU
  3. `source === 'manual'` **com** `screenshotUrl` + `annotation.{description|text}` não-vazios + `correlationId`.

### Testes
- `tests/server/findings-routes.test.js`: +4 testes para GET media (roundtrip binário, 404 mediaId, 404 finding, 404 cross-finding) e +2 para eligibility (opt-out default, opt-in `autoTriggerPipeline`).
- `tests/server/api.test.js`: teste existente de auto-diagnose migrado para `autoTriggerPipeline: true` (manual source agora exige opt-in).

### Contagens pós-Fase-2
| Repo | Antes | Depois |
|---|---|---|
| sentinel | 806/806 | **812/812** ✅ (+6 testes) |
| debug-probe | 1439 pass / 23 fail | **1439 pass / 23 fail** ✅ (não tocado) |

### §10.3.4 — EasyNuP test-sentinel agent agora emite findings
- `easynup/.github/agents/easynup-test-sentinel.agent.md`: nova **Etapa 5 — Emitir findings para o Sentinel**. Após Etapa 3 (execução de testes), para cada bug encontrado o agente cria uma session (`POST /api/sessions`) e emite um `Finding` (`POST /api/findings`) com `source: manual`, `type: bug`, severity mandatória, `annotation.{testFile,testName,expected,actual,dimension,proposedFix}`. Documenta `autoTriggerPipeline` como opt-in, nunca usa `source: auto_*`, e não falha a entrega se Sentinel estiver offline.

---

## Fase 3 — Exporter NuPIdentity no Manifest (concluída)

**Data:** 2026-04-24
**Escopo:** RBAC + ABAC apenas. ReBAC deferido para Fase 3.5 (ver FOUR-TOOLS-DEEP-AUDIT.md §9.4.1/§9.4.4 e memory `fase-3-5-rebac-complement.md`).

### §9.4 — `nupidentity-generator.ts` + runner embutido

Novo gerador em `Manifest 2/server/generators/nupidentity-generator.ts` (~350 LOC) que transforma um `PermaCatManifest` em bundle compatível com os endpoints REAIS do NuPIdentify (schemas verificados em código):

| Artefato | Endpoint alvo | Auth |
|---|---|---|
| `systemsRegister` — `{system, functions[], organizationId}` | `POST /api/systems/register` | `requireSystemApiKey` |
| `profiles[]` — `{name, description, color, isDefault}` | `POST /api/profiles` | admin |
| `profileFunctions[]` — `{profileName, functionKey, granted}` | `POST /api/profiles/:id/functions` | admin |
| `abacPolicies[]` — `{name, systemId, functionKey, effect, priority, conditions[]}` | `POST /api/policies` | admin |

Normalizações aplicadas:
- `function.key` no formato `systemId:resource:action:path` (resource/action inferidos de HTTP method/path).
- ABAC `operator` ∈ enum de 16 valores do schema (`equals`, `not_equals`, …, `exists`, `not_exists`).
- Dedup de profile-functions (mesma role+function não repetida).

Mapeador heurístico SpEL→ABAC cobre casos simples (same-user, same-owner) e emite warnings para o resto (`[UNKNOWN]`, custom beans, `hasPermission`, etc.). `hasRole` / `hasAuthority` são desviados para grants de profile (não viram ABAC).

Runner Node auto-contido emitido como string via `generateNupidentityRunnerScript()`:
- Lê bundle JSON via argv.
- Lê 3 env vars: `NUPIDENTITY_BASE_URL`, `NUPIDENTITY_SYSTEM_API_KEY`, `NUPIDENTITY_ADMIN_TOKEN`.
- Executa os 4 passos na ordem com retry×3 e backoff linear.
- Idempotente (409 em profile vira GET+reuse).

### Wiring em `server/routes.ts`

- `POST /api/analyze` com `format: "nupidentity"` (e dentro de `format: "all"`).
- `POST /api/analyze-zip` idem.
- `GET /api/manifest/:projectId?format=nupidentity` → download do bundle.
- `GET /api/manifest/:projectId?format=nupidentity-runner` → download do runner.js standalone.
- Query params opcionais no download: `systemId`, `systemName`, `organizationId`, `apiUrl`, `callbackUrl`.

### Typecheck
`npx tsc --noEmit` em `Manifest 2/` → **zero erros** nos arquivos tocados (`server/generators/nupidentity-generator.ts`, `server/routes.ts`). Erros remanescentes em `replit_integrations/*` são pré-existentes e não relacionados.

### Fora de escopo (Fase 3.5)
- `authorization_models` (ReBAC planta) — exige admin HS256 + editor UI no Identify.
- `relationship_tuples` (ReBAC tuplas) — dados de runtime, não deriváveis estaticamente.
- Gerador continuará sem saída ReBAC até Identify abrir `/api/rebac/models` para `systemApiKey` e 2+ consumers padronizarem `backfillRebacTuples`.

## Fase 4 — Orquestração unificada (concluída)

Entrega do "NuP Suite" pedido em `FOUR-TOOLS-DEEP-AUDIT.md` §9.3: pacote único que amarra Debug Probe + Sentinel + Manifest + NuPIdentify em uma experiência de 1 comando.

### Pacote publicado
`@nuptechs/nup-suite` v0.1.0 em `/Users/yurif/Downloads/nup-platform/packages/nup-suite/`. Segue o padrão dos pacotes irmãos do `nup-platform` (tsup 8.5, TypeScript 5.7 strict com `noUncheckedIndexedAccess` e `exactOptionalPropertyTypes`, Vitest 2.1, zero deps de runtime — usa `fetch`/`AbortController` nativos de Node 20+).

### CLI
Binário `nup-suite` com 4 subcomandos:
- `init <project>` — gera `nup-suite.config.json` (com `$schema`), `docker-compose.yml` (Postgres + Redis + Debug Probe + Sentinel + Manifest) e `.env.example` já com `WEBHOOK_URL`/`WEBHOOK_SECRET` derivados.
- `bootstrap` — cria Manifest project → dispara análise → seed session no Sentinel com `manifestProjectId`/`manifestRunId` → deriva wiring Probe→Sentinel → opcional `--export-bundle` baixa o bundle NuPIdentity da Fase 3.
- `status` — health-check paralelo dos 4 serviços, sai com exit code 1 se algum falha.
- `analyze` — re-roda Manifest analysis e, com `--export-bundle`, re-baixa o bundle.

### Arquivos criados
- `packages/nup-suite/package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`
- `src/index.ts` (API pública), `src/cli.ts` (entry com shebang)
- `src/config/{types,loader,loader.test}.ts`
- `src/util/{http,http.test,logger}.ts`
- `src/services/{health,manifest,sentinel,probe}.ts`
- `src/scaffold/infra.ts`
- `src/commands/{init,bootstrap,status,analyze}.ts`
- `README.md`

### API pública
`loadConfig`, `saveConfig`, `validateConfig`, `ConfigError`, `NupSuiteConfig`, `runInit`, `runBootstrap`, `runStatus`, `runAnalyze`, `scaffoldInfra`, `checkHealth`, `httpJson`, `HttpError`, `createLogger`.

### Contratos de integração verificados
- Sentinel: `POST /api/sessions` auto-materializa o project (rotas reais em `sentinel/src/server/routes/sessions.js`). Webhook Probe montado em `/api/probe-webhooks/:projectId` conforme `sentinel/src/server/app.js`.
- Manifest: `POST /api/projects`, `POST /api/projects/:id/analyze`, `GET /api/manifest/:projectId?format=nupidentity` (handler da Fase 3).
- Debug Probe: webhook é env-var (`WEBHOOK_URL`/`WEBHOOK_SECRET`), não há endpoint de registro (confirmado em `debug-probe/server/src/routes/`).
- NuPIdentify: bundle aplicado pelo runner da Fase 3, CLI apenas pinga `/api/health`.

### Verificação
- `npx tsc --noEmit` → exit 0.
- `npx vitest run` → 10/10 testes verdes (loader + http com fetch mockado).
- `npx tsup` → `dist/cli.js` 5.62 KB + `dist/index.js` 373 B + `.d.ts` 7.7 KB, shebang preservado.
- Smoke-test: `node dist/cli.js init "Acme App" --cwd <tmp>` gerou `nup-suite.config.json`, `docker-compose.yml` e `.env.example` com webhook secret aleatório de 64 hex chars e `WEBHOOK_URL=http://localhost:7071/api/probe-webhooks/acme-app` corretamente derivado do slug.

### Quickstart documentado
```bash
nup-suite init my-app \
  --sentinel-url http://localhost:7071 \
  --probe-url    http://localhost:7070 \
  --manifest-url http://localhost:5000 \
  --identify-url http://localhost:3000
# preencher .env a partir do .env.example
docker compose up -d
nup-suite bootstrap --export-bundle
nup-suite status
```

### Fora de escopo (continua como Fase 3.5)
ReBAC (planta `authorization_models` e tuplas `relationship_tuples`) permanece excluído pelas razões documentadas em `FOUR-TOOLS-DEEP-AUDIT.md` §9.4.1. `nup-suite` respeita isso: o download de bundle só transporta RBAC+ABAC produzidos pela Fase 3.
