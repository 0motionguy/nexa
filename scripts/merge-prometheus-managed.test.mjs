import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const alertsFile = new URL("../infra/prometheus/alerts.yml", import.meta.url);

import { mergeManagedPrometheus } from "./merge-prometheus-managed.mjs";

function names(document, key) {
  const pattern = new RegExp(`^  - ${key}: (.+)$`, "gm");
  return [...document.matchAll(pattern)].map((match) => match[1]);
}

test("restores canonical groups, preserves host extras, and replaces only managed rules", () => {
  const canonical = `groups:
  - name: toolbox-core
    rules:
      - alert: ToolboxCoreDown
        expr: up == 0
  - name: ansem-data-pulse
    rules:
      - alert: AnsemDataPulseWatchdogStale
        expr: absent(toolbox_ansem_data_pulse_captured_timestamp_seconds)
`;
  const current = `groups:
  - name: toolbox-core
    rules:
      - alert: ToolboxCoreDown
        expr: up == 0
# NEXA Prometheus rules - managed by neobank deploy-vps.sh; do not edit below.
  - name: maze-http
    rules:
      - alert: LegacyMazeApiDown
        expr: legacy_expr
  - name: host-local-extra
    rules:
      - alert: KeepHostLocalExtra
        expr: vector(1)
`;
  const managed = `groups:
  - name: maze-http
    rules:
      - alert: MazeApiDown
        expr: up{job="neobank-api"} == 0
`;

  const result = mergeManagedPrometheus({
    canonical,
    current,
    managed,
    section: "groups",
    itemKey: "name",
    markerLabel: "NEXA Prometheus rules",
  });

  assert.deepEqual(names(result, "name"), [
    "toolbox-core",
    "ansem-data-pulse",
    "host-local-extra",
    "maze-http",
  ]);
  assert.match(result, /AnsemDataPulseWatchdogStale/);
  assert.match(result, /KeepHostLocalExtra/);
  assert.match(result, /MazeApiDown/);
  assert.doesNotMatch(result, /LegacyMazeApiDown|legacy_expr/);
  assert.equal((result.match(/managed by neobank deploy-vps\.sh; do not edit below/g) ?? []).length, 1);
  assert.equal((result.match(/END NEXA Prometheus rules/g) ?? []).length, 1);
});

test("preserves canonical and host-only scrape jobs while replacing MAZE jobs", () => {
  const canonical = `global:
  scrape_interval: 30s
scrape_configs:
  - job_name: prometheus
    static_configs: []
  - job_name: host-textfile
    static_configs: []
remote_write:
  - url: http://remote-write.invalid
`;
  const current = `global:
  scrape_interval: 30s
scrape_configs:
  - job_name: prometheus
    static_configs: []
  # NEXA Prometheus scrape - managed by neobank deploy-vps.sh; do not edit below.
  - job_name: neobank-api
    static_configs:
      - targets: ["old:8090"]
  - job_name: tenant-extra
    static_configs: []
`;
  const managed = `  - job_name: neobank-api
    static_configs:
      - targets: ["neobank-api:8090"]
`;

  const result = mergeManagedPrometheus({
    canonical,
    current,
    managed,
    section: "scrape_configs",
    itemKey: "job_name",
    markerLabel: "NEXA Prometheus scrape",
    markerIndent: 2,
  });

  assert.deepEqual(names(result, "job_name"), [
    "prometheus",
    "host-textfile",
    "tenant-extra",
    "neobank-api",
  ]);
  assert.match(result, /neobank-api:8090/);
  assert.doesNotMatch(result, /old:8090/);
  assert.match(result, /^  # NEXA Prometheus scrape/m);
  assert.ok(
    result.indexOf("# END NEXA Prometheus scrape") < result.indexOf("remote_write:"),
    "managed jobs must remain inside scrape_configs",
  );
});

test("rejects duplicate managed item names", () => {
  assert.throws(
    () => mergeManagedPrometheus({
      canonical: `groups:
  - name: core
    rules: []
`,
      current: `groups:
  - name: core
    rules: []
`,
      managed: `groups:
  - name: maze
    rules: []
  - name: maze
    rules: []
`,
      section: "groups",
      itemKey: "name",
      markerLabel: "NEXA Prometheus rules",
    }),
    /duplicate name: maze/,
  );
});

test("uses cadence-aware heartbeat budgets for periodic workers", async () => {
  const alerts = await readFile(alertsFile, "utf8");

  assert.match(
    alerts,
    /time\(\) - worker_heartbeat_seconds\{worker=~"scheduler\|fills-notifier\|deposit-reconcile"\} > 600/,
  );
  assert.match(
    alerts,
    /time\(\) - worker_heartbeat_seconds\{worker="subscription-renewer"\} > 4500/,
  );
  assert.match(
    alerts,
    /time\(\) - worker_heartbeat_seconds\{worker=~"claim-sweep\|digest-sender"\} > 93600/,
  );
  assert.doesNotMatch(alerts, /time\(\) - worker_heartbeat_seconds > 600/);
  assert.doesNotMatch(alerts, /worker=~"[^"]*(?:approvals|bridge-transfer)/);
});
