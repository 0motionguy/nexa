# Prometheus rules and scrape

MAZE metrics are scraped by the toolbox Prometheus service on the shared
`data` Docker network.

`scripts/deploy-vps.sh` manages two host-side blocks when
`/opt/toolbox/infra/grafana` exists:

- appends `infra/prometheus/scrape-neobank.yml` under
  `/opt/toolbox/infra/grafana/prometheus.yml` `scrape_configs`
- appends the groups from `infra/prometheus/alerts.yml` under
  `/opt/toolbox/infra/grafana/alert_rules.yml`

The scrape uses `job_name: neobank-api`, target `neobank-api:8090`, and
`Authorization: Bearer ${METRICS_TOKEN}`. On the host, `METRICS_TOKEN` must be
present in the API's secrets env file; deploy fails
closed instead of installing an unauthenticated scrape that can never work.

After updating either file, deploy restarts the toolbox Prometheus container.
`scripts/verify-deploy-contract.mjs` pins this contract, including the
`MazeApiDown` alert firing after 60 seconds of `up == 0`.
