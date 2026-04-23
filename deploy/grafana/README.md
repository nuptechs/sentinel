# Sentinel — Grafana provisioning

Ready-to-mount Grafana provisioning (dashboards + alert rules) that reads from
Sentinel's Prometheus registry exposed at `GET /metrics`.

All panels and alerts target the `sentinel_*` metrics defined in
[`src/observability/metrics.js`](../../src/observability/metrics.js).

## Layout

```
deploy/grafana/
  dashboards/
    sentinel-overview.json          ← main dashboard (HTTP + findings + diagnosis)
  provisioning/
    datasources/datasources.yml     ← Prometheus datasource
    dashboards/dashboards.yml       ← autoload dashboards from /var/lib/grafana/dashboards
    alerting/alert-rules.yml        ← 4 alert rules
```

## How to mount (docker-compose snippet)

```yaml
services:
  grafana:
    image: grafana/grafana:latest
    volumes:
      - ./deploy/grafana/dashboards:/var/lib/grafana/dashboards:ro
      - ./deploy/grafana/provisioning:/etc/grafana/provisioning:ro
    ports:
      - "3001:3000"
```

Scrape target for Prometheus:

```yaml
scrape_configs:
  - job_name: sentinel
    static_configs:
      - targets: ["sentinel:7070"]
    metrics_path: /metrics
```

## Pattern source

Structure adapted from the EasyNuP observability stack
(`easynup/infra/observability/grafana/`). Metric names are Sentinel-native.
