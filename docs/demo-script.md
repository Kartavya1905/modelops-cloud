# 3-minute demo script

A spoken walkthrough for a screen share or a recorded video. Everything shown runs on one laptop at no cost. Measured numbers are quoted from the [benchmark report](benchmarks/report.md), which is generated from raw result files; nothing below is a number of its own.

## Before you start (5 minutes, not part of the demo)

```bash
pnpm dev:up && pnpm db:deploy && pnpm dev:obs   # platform + tracing + Grafana
pnpm dev                                        # API, worker, web on http://127.0.0.1:3300
pnpm --filter @modelops/e2e demo:record          # optional: sets up a demo account with a canary
```

Open three tabs: the web console, Grafana (`http://127.0.0.1:13001`), and a terminal.

## 0:00 – 0:20 · The problem

"Training a good model is the easy part. Getting it into production safely means packaging it, deploying it without downtime, rolling it back when it misbehaves, and noticing when the data drifts. ModelOps Cloud is that path as a product, built end to end: a web console, an API, a deployment engine, an inference gateway, and monitoring."

## 0:20 – 0:50 · From a model to a validated version

Open a model version page.

"A model arrives as an ONNX bundle, never a pickle, so loading it can't run code. Before it can be deployed, a sandboxed validator checks it: the format, the operators it uses, its signature, and whether it reproduces its own golden examples. This checklist is that result. Unvalidated versions can't be deployed: the API refuses, and so does a database trigger."

## 0:50 – 1:40 · A safe release

Open the endpoint page.

"Each revision runs in its own hardened container: non-root, read-only, no network path to the database. Here version 1 is stable and version 2 is a canary taking 20 % of the traffic. An analysis compares the canary's error rate and latency with the stable revision every 15 seconds and aborts it on its own if it's worse. Rollback is one click. Because the previous revision stays warm, the switch is a routing change, not a restart: the benchmark measures it in milliseconds."

Click **Run check**, then **Predict** in the playground.

"The playground form is generated from the model's signature. The same request through the public gateway needs an API key, is rate limited, and is validated against the signature before it reaches the model."

## 1:40 – 2:20 · Seeing what happens

Switch to Grafana → Endpoint dashboard, then open a trace.

"Every prediction is one trace, from the gateway into the model server, so a slow request shows where the time went. Prometheus has the request rate, the latency by model version, and the canary fallbacks. The dashboards, the six alert rules and their runbooks are code in the repo."

## 2:20 – 2:45 · It holds up

Show the benchmark report.

"I measured it rather than guessing: steady load, a ramp to find where a default-sized model server saturates, the canary split, and rollback time. A chaos suite kills the worker, flushes Redis and pauses Postgres mid-deployment; every deployment still ends in the right state."

## 2:45 – 3:00 · How it's built

"It runs on Docker Compose or on a local Kubernetes cluster with the same tests; the AWS deployment is Terraform that is linted and policy-checked in CI but never applied, because the whole project costs nothing. The CI pipeline pins every action and image, scans every image and publishes them with an SBOM."
