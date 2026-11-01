import { readFile } from 'node:fs/promises';

const checks = [];

function expectIncludes(name, content, needle) {
  checks.push({ name, ok: content.includes(needle), detail: `missing ${needle}` });
}

function expectMatches(name, content, pattern) {
  checks.push({ name, ok: pattern.test(content), detail: `missing ${pattern}` });
}

function expectNotMatches(name, content, pattern) {
  checks.push({ name, ok: !pattern.test(content), detail: `unexpected ${pattern}` });
}

const caddy = await readFile(new URL('../infra/caddy-fragment.conf', import.meta.url), 'utf8');
const nginx = await readFile(new URL('../apps/web/nginx.conf', import.meta.url), 'utf8');
const compose = await readFile(new URL('../infra/compose-fragment.yml', import.meta.url), 'utf8');
const alerts = await readFile(new URL('../infra/prometheus/alerts.yml', import.meta.url), 'utf8');
const prometheusScrape = await readFile(new URL('../infra/prometheus/scrape-neobank.yml', import.meta.url), 'utf8');
const deploy = await readFile(new URL('../scripts/deploy-vps.sh', import.meta.url), 'utf8');
const publicConnectivity = await readFile(new URL('../scripts/verify-public-connectivity.mjs', import.meta.url), 'utf8');
const deployWorkflow = await readFile(new URL('../.github/workflows/build-and-push.yml', import.meta.url), 'utf8');
const apiTsconfig = await readFile(new URL('../apps/api/tsconfig.json', import.meta.url), 'utf8');
const apiDockerfile = await readFile(new URL('../apps/api/Dockerfile', import.meta.url), 'utf8');
const mayanAdapter = await readFile(new URL('../apps/api/src/lib/chain/mayan.ts', import.meta.url), 'utf8');

expectIncludes('caddy routes public app host', caddy, 'nexa.aiso.tools:80');
expectIncludes('caddy routes public portal host', caddy, 'portal.nexa.aiso.tools:80');
expectIncludes('caddy routes public api host', caddy, 'api.nexa.aiso.tools:80');
expectMatches('caddy routes payment-link domain', caddy, /(^|\n)maze\.to:80\s*\{/);
expectIncludes('nginx serves payment links through app shell', nginx, 'location /pay/');
expectMatches('nginx payment links resolve to app html', nginx, /location\s+\/pay\/\s*\{[\s\S]*try_files\s+\/app\.html\s+=404;/);
expectIncludes('nginx serves claim links through app shell', nginx, 'location /claim/');
expectMatches('nginx claim links resolve to app html', nginx, /location\s+\/claim\/\s*\{[\s\S]*try_files\s+\/app\.html\s+=404;/);
expectIncludes('compose builds neobank api from synced source', compose, 'dockerfile: apps/api/Dockerfile');
expectIncludes('compose builds neobank web from synced source', compose, 'dockerfile: apps/web/Dockerfile');
expectIncludes('compose forwards API base into web build', compose, 'VITE_NEXA_API_BASE');
expectIncludes('compose forwards payment-link base into web build', compose, 'VITE_MAZE_PAY_BASE_URL');
expectIncludes('compose forwards realtime hub flag into web build', compose, 'VITE_REALTIME_HUB_ENABLED: ${REALTIME_HUB_V1:-0}');
expectIncludes('compose sets runtime payment-link base', compose, 'PAY_LINK_BASE_URL');
expectIncludes('compose forwards realtime hub flag into api', compose, 'REALTIME_HUB_V1: ${REALTIME_HUB_V1:-0}');
expectIncludes('compose forwards realtime topic cap into api', compose, 'REALTIME_MAX_TOPICS_PER_CLIENT');
expectIncludes('compose forwards realtime message cap into api', compose, 'REALTIME_MAX_MSGS_PER_SEC');
expectNotMatches('compose leaves runtime claim-link base to env_file', compose, /^\s+CLAIM_LINK_BASE_URL:/m);
expectIncludes('compose defaults web build to maze API', compose, 'NEOBANK_PUBLIC_API_URL:-https://api.maze.bank');
expectIncludes('compose allows maze app origin', compose, 'WEB_ORIGIN: https://app.maze.bank');
expectIncludes('compose allows maze developer origin', compose, 'PORTAL_ORIGIN: https://dev.maze.bank');
expectIncludes('deploy smokes preview API path', deploy, 'https://maze.aiso.tools/api/healthz');
expectIncludes('deploy smokes preview web health', deploy, 'https://maze.aiso.tools/healthz');
expectIncludes('deploy smokes preview claim shell', deploy, 'https://maze.aiso.tools/claim/health-check');
expectIncludes('deploy makes preview smokes required', deploy, 'required_smoke_urls=(');
expectIncludes('deploy fails required smoke misses', deploy, 'fail: required smoke failed');
expectIncludes('deploy retries required startup smokes', deploy, 'SMOKE_ATTEMPTS');
expectIncludes('deploy smokes canonical API host', deploy, 'https://api.maze.bank/healthz');
expectIncludes('deploy smokes retained app alias API path', deploy, 'https://nexa.aiso.tools/api/healthz');
expectIncludes('deploy probes production transaction browser readiness', deploy, 'probe-production-transaction-readiness.mjs');
expectIncludes('deploy fails missing transaction CORS/card routes', deploy, 'fail: production transaction readiness failed');
expectIncludes('deploy supports smoke URL list override', deploy, 'NEOBANK_SMOKE_URLS');
expectIncludes('deploy rewrites active Caddy managed block', deploy, 'NEXA Caddy blocks - managed by neobank deploy-vps.sh');
expectIncludes('public verifier checks retained API alias', publicConnectivity, 'https://nexa.aiso.tools/api/healthz');
expectIncludes('public verifier checks preview claim route', publicConnectivity, 'https://maze.aiso.tools/claim/health-check');
expectIncludes('prometheus pages when maze api target is down', alerts, 'alert: MazeApiDown');
expectMatches('maze api down alert fires after 60s', alerts, /alert:\s*MazeApiDown[\s\S]*for:\s*60s/);
expectMatches('maze api down alert watches prometheus scrape up metric', alerts, /up\{job=~"maze-api\|neobank-api\|maze-neobank-api"\}\s*==\s*0/);
expectIncludes('prometheus scrape job uses neobank-api label', prometheusScrape, 'job_name: neobank-api');
expectIncludes('prometheus scrape job targets neobank api container', prometheusScrape, 'neobank-api:8090');
expectIncludes('prometheus scrape job sends metrics bearer token', prometheusScrape, 'credentials: ${METRICS_TOKEN}');
expectIncludes('deploy syncs maze prometheus rules into toolbox alert rules', deploy, '--marker-label "NEXA Prometheus rules"');
expectIncludes('deploy merges shared prometheus config without truncating other products', deploy, 'merge-prometheus-managed.mjs');
expectIncludes('deploy restores the canonical toolbox prometheus base', deploy, 'refs/remotes/origin/main');
expectIncludes('deploy reads the root-owned toolbox repo without global git config', deploy, '-c \"safe.directory=$TOOLBOX_REPO\"');
expectIncludes('deploy syncs maze prometheus scrape into toolbox config', deploy, '--marker-label "NEXA Prometheus scrape"');
expectIncludes('deploy preserves Ansem alert coverage', deploy, 'ansem-data-pulse');
expectIncludes('deploy validates merged prometheus config before install', deploy, 'check config /etc/prometheus/prometheus.yml');
expectIncludes('deploy restarts prometheus after config sync', deploy, 'compose restart prometheus');
expectIncludes('deploy exports metrics token for compose interpolation', deploy, 'export METRICS_TOKEN="$METRICS_TOKEN_VALUE"');
expectIncludes('deploy cleanup preserves successful exit status', deploy, 'return 0');
expectIncludes('deploy loads tenant env for compose interpolation', deploy, 'COMPOSE_ARGS+=(--env-file "$TENANT_ENV_FILE")');
expectIncludes('deploy resolves prefixed JWT secret from tenant fallback', deploy, 'export_from_env_files NEOBANK_JWT_SECRET JWT_SECRET');
expectIncludes('deploy resolves prefixed agent keys from tenant fallback', deploy, 'export_from_env_files NEOBANK_AGENT_KEYS NEXA_AGENT_KEYS');
expectIncludes('deploy resolves realtime hub flag from env files', deploy, 'export_from_env_files REALTIME_HUB_V1');
expectIncludes('deploy resolves Privy server secret from tenant env', deploy, 'export_from_env_files PRIVY_APP_SECRET');
expectIncludes('deploy resolves Privy verification key from tenant env', deploy, 'export_from_env_files PRIVY_VERIFICATION_KEY');
expectIncludes('deploy resolves Privy webhook secret from tenant env', deploy, 'export_from_env_files PRIVY_WEBHOOK_SECRET');
expectIncludes('deploy derives maze database url from toolbox postgres password', deploy, 'postgresql://toolbox:${val}@postgres:5432/maze');
expectIncludes('deploy derives redis url from toolbox redis password', deploy, 'redis://:${val}@redis:6379/2');
expectIncludes('deploy builds api fallback directly', deploy, 'docker build --pull');
expectIncludes('deploy tags fallback api image for compose', deploy, '-t "ghcr.io/0motionguy/neobank-api:${TAG}"');
expectIncludes('deploy tags fallback web image for compose', deploy, '-t "ghcr.io/0motionguy/neobank-web:${TAG}"');
expectIncludes('deploy persists active image tag into compose env', deploy, 'persist_neobank_tag');
expectIncludes('deploy rewrites stale NEOBANK_TAG line', deploy, 'NEOBANK_TAG=${TAG}');
expectIncludes('deploy forwards API base into direct web fallback build', deploy, '--build-arg "VITE_NEXA_API_BASE=${NEOBANK_PUBLIC_API_URL:-https://api.maze.bank}"');
expectIncludes('deploy forwards payment-link base into direct web fallback build', deploy, '--build-arg "VITE_MAZE_PAY_BASE_URL=${NEOBANK_PAY_LINK_BASE_URL:-https://maze.to/pay}"');
expectIncludes('deploy forwards realtime hub flag into direct web fallback build', deploy, '--build-arg "VITE_REALTIME_HUB_ENABLED=${REALTIME_HUB_V1:-0}"');
expectIncludes('deploy forwards privy app id into direct web fallback build', deploy, '--build-arg "VITE_PRIVY_APP_ID=${PRIVY_APP_ID:-}"');
expectIncludes('workflow deploys from VPS build context', deployWorkflow, '/opt/neobank/src');
expectIncludes('workflow persists exact source revision beside rsynced source', deployWorkflow, '.nexa-source-sha');
expectIncludes('source revision marker uses full GitHub SHA', deployWorkflow, 'printf \'%s\\n\' "$GITHUB_SHA"');
expectIncludes('source revision uses allowlisted sudo copy', deployWorkflow, 'sudo cp "$RUNNER_TEMP/nexa-source-sha"');
expectNotMatches('source revision avoids unallowlisted sudo tee', deployWorkflow, /sudo\s+tee/);
expectIncludes('workflow invokes deploy script', deployWorkflow, 'bash scripts/deploy-vps.sh "$NEOBANK_TAG"');
expectNotMatches('workflow does not block deploy on GHCR push', deployWorkflow, /docker\s+push\s+ghcr\.io/);
expectIncludes('api build excludes spec files', apiTsconfig, 'src/**/*.spec.ts');
expectIncludes('api build excludes test files', apiTsconfig, 'src/**/*.test.ts');
expectNotMatches('api dockerfile avoids parallel deps stage', apiDockerfile, /FROM node:22-alpine AS deps/);
expectIncludes('api dockerfile serializes prod dependency pass', apiDockerfile, 'pnpm install --frozen-lockfile --prod --filter @nexa/api...');
expectIncludes('mayan SDK check is ESM-safe', mayanAdapter, 'createRequire(import.meta.url)');
expectMatches('mayan SDK check does not use bare CommonJS require', mayanAdapter, /const\s+\w+\s*=\s*createRequire\(import\.meta\.url\);[\s\S]*\w+\.resolve\('@mayanfinance\/swap-sdk'\)/);

// Sprint 10 ζ — Caddy maze.bank hosts
expectMatches('caddy routes maze.bank apex', caddy, /(^|\n)maze\.bank:80\s*\{/);
expectMatches('caddy routes app.maze.bank', caddy, /(^|\n)app\.maze\.bank:80\s*\{/);
expectMatches('caddy routes api.maze.bank', caddy, /(^|\n)api\.maze\.bank:80\s*\{/);
expectMatches('caddy routes dev.maze.bank', caddy, /(^|\n)dev\.maze\.bank:80\s*\{/);
expectMatches('caddy routes checkout.maze.bank', caddy, /(^|\n)checkout\.maze\.bank:80\s*\{/);
expectMatches('caddy routes mcp.maze.bank', caddy, /(^|\n)mcp\.maze\.bank:80\s*\{/);
expectIncludes('caddy blocks /metrics on api host', caddy, '@metrics path /metrics');
expectIncludes('caddy blocks path-routed API metrics', caddy, '@apiMetrics path /api/metrics /api/metrics/*');

// Sprint 10 ζ — compose services
expectMatches('compose defines neobank-migrate one-shot', compose, /\bneobank-migrate:/);
expectMatches('compose defines neobank-scheduler service', compose, /\bneobank-scheduler:/);
expectMatches('migrate runs dist/migrate.js', compose, /node",\s*"dist\/migrate\.js/);
expectMatches('scheduler runs dist/workers/scheduler.js', compose, /node",\s*"dist\/workers\/scheduler\.js/);
expectIncludes('compose wires env_file for tenant secrets', compose, '/opt/neobank/secrets/maze.env');
expectNotMatches('compose does not blank env_file metrics token', compose, /^\s+METRICS_TOKEN:\s*\$\{METRICS_TOKEN:-\}/m);
expectMatches('neobank-api depends on migrate completion', compose, /neobank-migrate:\s*\n\s*condition:\s*service_completed_successfully/);

let failed = false;
for (const check of checks) {
  if (check.ok) {
    console.log(`ok: ${check.name}`);
  } else {
    failed = true;
    console.error(`fail: ${check.name} (${check.detail})`);
  }
}

if (failed) process.exitCode = 1;
