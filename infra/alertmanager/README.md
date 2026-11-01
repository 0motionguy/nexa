# Alertmanager fanout (MAZE → Slack)

Routing config for the toolbox host's Alertmanager. Sits beside
`infra/prometheus/alerts.yml` (rule definitions). Alerts fan out to two Slack
channels: warnings to `#maze-alerts`, criticals to `#maze-alerts-critical`.

## Why this isn't in `compose-fragment.yml`

One AlertManager per toolbox host. The shared service lives in
`/opt/toolbox/infra/compose/docker-compose.yml` alongside Prometheus, not in
MAZE's tenant fragment. This repo only ships the routing config; deploy
copies it into the host's AlertManager directory.

## Deploy

`scripts/deploy-vps.sh` syncs the config automatically on each deploy. To
sync manually (mirrors the Caddy fragment sync pattern):

```bash
sudo cp infra/alertmanager/config.yml /opt/toolbox/alertmanager/maze.yml
cd /opt/toolbox && docker compose restart alertmanager
```

The deploy script copies the rendered file. If `ALERTMANAGER_SLACK_WEBHOOK_URL`
is present, it also restarts Alertmanager so routing changes take effect. If the
webhook URL is unset, it leaves the container running and prints a warning.

## Required env

`ALERTMANAGER_SLACK_WEBHOOK_URL` must be exported into the AlertManager
container's environment (typically via `/opt/toolbox/.env`). Generate the
webhook URL at https://api.slack.com/messaging/webhooks.

The env is documented in `apps/api/.env.example` for discovery, but it is
NOT consumed by the MAZE api or scheduler containers — only by the toolbox
AlertManager service.

## Routing summary

- **Default route** → `slack-default` receiver → `#maze-alerts`
  - `group_wait: 30s`, `group_interval: 5m`, `repeat_interval: 4h`
- **Critical match (`severity: critical`)** → `slack-critical` receiver → `#maze-alerts-critical`
  - `group_wait: 10s`, `repeat_interval: 30m`
- **Inhibit rule**: a firing critical alert suppresses warnings with the
  same `alertname` + `service` (no double-paging on the same incident).

## Test it

Force a synthetic alert directly against the AlertManager API and confirm a
Slack message arrives:

```bash
curl -X POST http://localhost:9093/api/v2/alerts \
  -H 'Content-Type: application/json' \
  -d '[{"labels":{"alertname":"TestAlert","severity":"warning","service":"maze-test"},"annotations":{"summary":"test alert"}}]'
```

Critical variant (should hit `#maze-alerts-critical`):

```bash
curl -X POST http://localhost:9093/api/v2/alerts \
  -H 'Content-Type: application/json' \
  -d '[{"labels":{"alertname":"TestCritical","severity":"critical","service":"maze-test"},"annotations":{"summary":"test critical alert"}}]'
```

## Silence an alert

During planned maintenance or to mute a known-noisy alert, use `amtool`
(installed on the toolbox VPS) or the AlertManager UI at
`https://alerts.maze.bank/`:

```bash
amtool silence add alertname=PaymentsFailedRateHigh \
  --duration 1h \
  --author=mirko \
  --comment="planned maintenance"
```

List active silences:

```bash
amtool silence query
```

Expire a silence early:

```bash
amtool silence expire <silence-id>
```

## PagerDuty

Sprint 13 follow-up. Add a `pagerduty_configs` block to the `slack-critical`
receiver once a PagerDuty service key is provisioned. Pattern:

```yaml
  - name: slack-critical
    slack_configs: [...]
    pagerduty_configs:
      - service_key: '${PAGERDUTY_SERVICE_KEY}'
        severity: critical
```
