// M10: screenshots of the provisioned Grafana dashboards, showing the platform on kind.
//   pnpm kind:up && pnpm kind:smoke --requests 900 && pnpm --filter @modelops/e2e screenshots:grafana
// Logs in with HTTP basic auth (Grafana's local admin from the generated .env); writes
// docs/images/m10-*.png in light and dark mode.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const root = join(import.meta.dirname, '..', '..');
if (existsSync(join(root, '.env'))) process.loadEnvFile(join(root, '.env'));
const GRAFANA = `http://127.0.0.1:${process.env.MO_PORT_GRAFANA ?? '13001'}`;
const OUT = join(root, 'docs', 'images');

const PROMETHEUS = `http://127.0.0.1:${process.env.MO_PORT_PROMETHEUS ?? '19090'}`;

/** The kind endpoint with the most traffic in the last 30 minutes (e.g. the last kind:smoke). */
async function busiestKindEndpoint(): Promise<string> {
  const q =
    'topk(1, sum by (endpoint) (increase(gateway_requests_total{stack="kind", source="api"}[30m])))';
  const res = await fetch(`${PROMETHEUS}/api/v1/query?query=${encodeURIComponent(q)}`);
  const body = (await res.json()) as { data: { result: { metric: { endpoint: string } }[] } };
  const slug = body.data.result[0]?.metric.endpoint;
  if (!slug) throw new Error('no kind traffic in the last 30 minutes: run `pnpm kind:smoke` first');
  return slug;
}

const endpoint = await busiestKindEndpoint();
const DASHBOARDS = [
  // Pod CPU and memory as a share of their limits (kubelet cAdvisor).
  { name: 'm10-grafana-kubernetes', path: '/d/modelops-kubernetes', range: '30m', vars: '' },
  // Traffic, latency and errors of one endpoint served on kind, plus its traces from Tempo.
  {
    name: 'm10-grafana-endpoint',
    path: '/d/modelops-endpoint',
    range: '30m',
    vars: `&var-stack=kind&var-endpoint=${endpoint}`,
  },
  // Platform overview read from the kind database (hourly panels need a wider window).
  {
    name: 'm10-grafana-platform',
    path: '/d/modelops-platform',
    range: '6h',
    vars: '&var-stack=kind&var-db=modelops-db-kind',
  },
];

async function main(): Promise<void> {
  const browser = await chromium.launch();
  for (const theme of ['light', 'dark'] as const) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      // Grafana redirects browsers to /login instead of answering 401, so Playwright's
      // httpCredentials (sent only after a 401 challenge) never applies: send the header always.
      extraHTTPHeaders: {
        authorization: `Basic ${Buffer.from(`admin:${process.env.MO_GRAFANA_ADMIN_PASSWORD ?? ''}`).toString('base64')}`,
      },
    });
    const page = await context.newPage();
    for (const d of DASHBOARDS) {
      await page.goto(
        `${GRAFANA}${d.path}?orgId=1&from=now-${d.range}&to=now&kiosk&theme=${theme}${d.vars}`,
      );
      await page.waitForLoadState('networkidle');
      // Panels render after their queries return; give the charts a moment to draw.
      await page.waitForTimeout(3000);
      const file = `${d.name}${theme === 'dark' ? '-dark' : ''}.png`;
      await page.screenshot({ path: join(OUT, file) });
      console.log(`screenshot: docs/images/${file}`);
    }
    await context.close();
  }
  await browser.close();
}

await main();
