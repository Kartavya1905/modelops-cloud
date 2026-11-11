#!/usr/bin/env node
// M9: container hardening check (docs/06 §6). Inspects the RUNNING containers of the stack and
// every model server (`docker inspect`), not the compose file, so it checks what Docker actually
// applied. Exceptions are listed below with their reason; anything else that fails exits 1.
//
//   pnpm check:hardening            # table + exit code
//   pnpm check:hardening --json     # machine-readable
import { execFileSync } from 'node:child_process';

const json = process.argv.includes('--json');
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim();

const names = docker('ps', '--format', '{{.Names}}')
  .split('\n')
  .filter((n) => /^modelops-[a-z-]+-1$/.test(n) || /^mo-rev-[0-9a-f-]{36}$/.test(n));
if (names.length === 0) {
  console.error('hardening: no running modelops containers (pnpm dev:up first)');
  process.exit(2);
}
const info = JSON.parse(docker('inspect', ...names));

/** Reviewed exceptions: [container (pattern), check] -> why it is acceptable. */
const EXCEPTIONS = [
  [
    /docker-proxy/,
    'nonRoot',
    'reads the root-owned Docker socket; no capabilities, read-only socket mount, an allow-list of API calls, 127.0.0.1 only (ADR-0005)',
  ],
  [
    /docker-proxy/,
    'readOnlyRootfs',
    'renders its haproxy.cfg from the allow-list at start-up; no capabilities',
  ],
  // M10: distroless images (no shell, no HTTP client) cannot run a Docker healthcheck. Their
  // health is still observed: Tempo through `pnpm test:k8s`/the tracing test (/ready), the
  // collector through the traces arriving in Tempo, and both by `pnpm kind:smoke`.
  [
    /tempo/,
    'healthcheck',
    'distroless image: nothing inside can run a check; /ready is probed by the tracing tests',
  ],
  [
    /otel-collector/,
    'healthcheck',
    'distroless image: nothing inside can run a check; a broken collector shows as missing traces',
  ],
];
const excused = (name, check) => EXCEPTIONS.find(([re, c]) => re.test(name) && c === check)?.[2];

const CHECKS = {
  nonRoot: (c) => {
    const user = c.Config.User || '';
    return user !== '' && !/^(root|0)(:|$)/.test(user);
  },
  readOnlyRootfs: (c) => c.HostConfig.ReadonlyRootfs === true,
  capDropAll: (c) => (c.HostConfig.CapDrop ?? []).map((x) => x.toUpperCase()).includes('ALL'),
  noNewPrivileges: (c) =>
    (c.HostConfig.SecurityOpt ?? []).some((o) => /^no-new-privileges(:true|=true)?$/.test(o)),
  memoryLimit: (c) => c.HostConfig.Memory > 0,
  cpuLimit: (c) => c.HostConfig.NanoCpus > 0 || c.HostConfig.CpuQuota > 0,
  pidsLimit: (c) => (c.HostConfig.PidsLimit ?? 0) > 0,
  healthcheck: (c) => Boolean(c.Config.Healthcheck?.Test?.length) || c.Name.includes('mo-rev-'),
  portsLocalhostOnly: (c) =>
    Object.values(c.HostConfig.PortBindings ?? {})
      .flat()
      .every((b) => b && b.HostIp === '127.0.0.1'),
  dockerSocket: (c) => {
    const sock = (c.Mounts ?? []).find((m) => m.Source?.endsWith('docker.sock'));
    if (!sock) return true;
    return c.Name.includes('docker-proxy') && sock.RW === false;
  },
  internalNetworkOnly: (c) => {
    if (!c.Name.includes('mo-rev-')) return true;
    return Object.keys(c.NetworkSettings.Networks ?? {}).every((n) => n.endsWith('inference'));
  },
};

const rows = [];
let unexpected = 0;
for (const c of info) {
  const name = c.Name.replace(/^\//, '');
  const results = {};
  for (const [check, fn] of Object.entries(CHECKS)) {
    const ok = fn(c);
    const why = ok ? null : excused(name, check);
    results[check] = ok ? 'ok' : why ? 'excepted' : 'FAIL';
    if (!ok && !why) unexpected++;
  }
  rows.push({ name: name.startsWith('mo-rev-') ? 'mo-rev-… (model server)' : name, ...results });
}
// One line per kind of model server is enough.
const unique = rows.filter(
  (r, i) => !r.name.startsWith('mo-rev-') || rows.findIndex((x) => x.name === r.name) === i,
);

if (json) {
  console.log(
    JSON.stringify(
      {
        containers: unique,
        exceptions: EXCEPTIONS.map(([re, c, w]) => ({ container: String(re), check: c, why: w })),
        unexpected,
      },
      null,
      2,
    ),
  );
} else {
  const cols = Object.keys(CHECKS);
  console.log(['container', ...cols].join(' | '));
  for (const r of unique) console.log([r.name, ...cols.map((k) => r[k])].join(' | '));
  console.log('');
  for (const [re, check, why] of EXCEPTIONS)
    console.log(`exception ${String(re)} ${check}: ${why}`);
  console.log(
    unexpected === 0
      ? `\nhardening: ${String(info.length)} containers, no unexpected gaps`
      : `\nhardening: ${String(unexpected)} unexpected gap(s)`,
  );
}
process.exit(unexpected === 0 ? 0 : 1);
