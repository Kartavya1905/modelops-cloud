#!/usr/bin/env node
/**
 * aws-free.mjs: the AWS free-plan server (docs/14-aws-free-plan.md, ADR-0009), from your laptop.
 *
 *   pnpm aws:up       create the server, or update it (e.g. your IP changed). Shows the plan and
 *                     asks "yes" before changing anything.  --allow 1.2.3.4/32,... adds addresses.
 *   pnpm aws:status   state, current addresses, whether the platform answers yet
 *   pnpm aws:stop     stop the server: compute stops using credits; disk and data stay
 *   pnpm aws:start    start it again (it gets a new public IP; the platform adopts it on boot)
 *   pnpm aws:smoke    end-to-end check against the running server (scripts/cloud-smoke.mjs)
 *   pnpm aws:down     delete everything (asks "yes" first; data on the server is lost)
 *
 * Needs the AWS CLI signed in with `aws login` (short-lived credentials, no access keys). The
 * credentials are handed to Terraform's container as environment variables for one command
 * and never written anywhere. Terraform runs in the same pinned image as `pnpm tf:check`.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tfDir = join(root, 'infra', 'terraform');
const REGION = process.env.AWS_REGION ?? 'us-east-1';
// One source of truth for the Terraform image: the one tf:check validates with.
const TERRAFORM = readFileSync(join(root, 'scripts', 'terraform-check.mjs'), 'utf8').match(
  /hashicorp\/terraform:[^'"]+/,
)[0];

const { positionals, values: opts } = parseArgs({
  allowPositionals: true,
  options: { allow: { type: 'string', default: '' } },
});
const command = positionals[0] ?? 'status';

function die(msg) {
  console.error(`aws: ${msg}`);
  process.exit(1);
}

function aws(...args) {
  try {
    const out = execFileSync('aws', [...args, '--region', REGION, '--output', 'json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return out.trim() ? JSON.parse(out) : null;
  } catch (err) {
    if (err.code === 'ENOENT')
      die('the AWS CLI is not installed: winget install --id Amazon.AWSCLI -e');
    const msg = String(err.stderr ?? err.message);
    if (/login|expired|credentials|token/i.test(msg))
      die(`not signed in (run \`aws login\`)\n${msg}`);
    die(msg);
  }
}

/** Temporary credentials of the signed-in CLI session, for one Terraform run. */
function credentials() {
  let out;
  try {
    out = execFileSync('aws', ['configure', 'export-credentials', '--format', 'process'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    if (err.code === 'ENOENT')
      die('the AWS CLI is not installed: winget install --id Amazon.AWSCLI -e');
    die(`no AWS session: run \`aws login\` first\n${String(err.stderr ?? '')}`);
  }
  const c = JSON.parse(out);
  return {
    AWS_ACCESS_KEY_ID: c.AccessKeyId,
    AWS_SECRET_ACCESS_KEY: c.SecretAccessKey,
    ...(c.SessionToken ? { AWS_SESSION_TOKEN: c.SessionToken } : {}),
  };
}

async function myIp() {
  const ip = (await (await fetch('https://checkip.amazonaws.com')).text()).trim();
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) die(`could not determine your public IP (got "${ip}")`);
  return ip;
}

function terraform(args, creds) {
  const pass = Object.keys(creds).flatMap((k) => ['-e', k]); // names only: values via env
  const r = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '-i',
      ...(process.stdin.isTTY ? ['-t'] : []),
      ...['-v', `${tfDir}:/work`, '-v', 'modelops-tf-plugins:/plugins'],
      ...['-e', 'TF_PLUGIN_CACHE_DIR=/plugins', '-e', 'TF_IN_AUTOMATION=1', ...pass],
      ...['-w', '/work', TERRAFORM, '-chdir=envs/free-plan', ...args],
    ],
    { stdio: 'inherit', env: { ...process.env, ...creds, MSYS_NO_PATHCONV: '1' } },
  );
  if (r.status !== 0) die(`terraform ${args[0]} failed (exit ${String(r.status)})`);
}

async function tfVars(creds) {
  const extra = opts.allow ? opts.allow.split(',').map((s) => s.trim()) : [];
  const cidrs = [`${await myIp()}/32`, ...extra];
  terraform(['init', '-input=false', '-lockfile=readonly'], creds);
  return [`-var=allowed_cidrs=${JSON.stringify(cidrs)}`, `-var=region=${REGION}`];
}

function server() {
  const res = aws(
    'ec2',
    'describe-instances',
    '--filters',
    'Name=tag:project,Values=modelops-cloud',
    'Name=tag:environment,Values=free-plan',
    'Name=instance-state-name,Values=pending,running,stopping,stopped',
  );
  const all = res.Reservations.flatMap((r) => r.Instances);
  if (all.length > 1)
    console.warn(`aws: warning: ${String(all.length)} servers found, using the first`);
  const i = all[0];
  if (!i) return null;
  return {
    id: i.InstanceId,
    state: i.State.Name,
    type: i.InstanceType,
    ip: i.PublicIpAddress ?? null,
    since: i.LaunchTime,
    sg: i.SecurityGroups?.[0]?.GroupId,
  };
}

async function status() {
  const s = server();
  if (!s) {
    console.log('No ModelOps server exists. Create one with: pnpm aws:up');
    return null;
  }
  console.log(
    `server   ${s.id} (${s.type}) ${s.state}${s.state === 'running' ? ` since ${s.since}` : ''}`,
  );
  if (s.state !== 'running' || !s.ip) {
    if (s.state === 'stopped') console.log('         start it with: pnpm aws:start');
    return s;
  }
  console.log(`web      http://${s.ip}:3300`);
  console.log(`gateway  http://${s.ip}:18088`);
  console.log(`grafana  http://${s.ip}:13001`);

  // Is this laptop still on the allow-list? (home IPs change)
  const ip = await myIp();
  const rules = aws(
    'ec2',
    'describe-security-group-rules',
    '--filters',
    `Name=group-id,Values=${s.sg}`,
  );
  const allowed = rules.SecurityGroupRules.filter((r) => !r.IsEgress).map((r) => r.CidrIpv4);
  if (!allowed.includes(`${ip}/32`)) {
    console.log(`\nYour IP is now ${ip}, which the server does not admit. Run: pnpm aws:up`);
    return s;
  }
  const up = await fetch(`http://${s.ip}:3300/login`, { signal: AbortSignal.timeout(5000) })
    .then((r) => r.ok)
    .catch(() => false);
  console.log(
    up
      ? '\nThe platform is up: open the web console address above.'
      : '\nThe platform is still starting (first start: about 10-15 minutes, later starts: 1-3).',
  );
  return s;
}

switch (command) {
  case 'up': {
    const creds = credentials();
    const vars = await tfVars(creds);
    terraform(['apply', '-input=true', ...vars], creds);
    console.log(
      '\nCreated/updated. The first start builds every image on the server: about 10-15 minutes.',
    );
    console.log('Check progress with: pnpm aws:status');
    break;
  }
  case 'down': {
    const creds = credentials();
    const vars = await tfVars(creds);
    terraform(['destroy', '-input=true', ...vars], creds);
    break;
  }
  case 'start': {
    const s = server() ?? die('no server: pnpm aws:up');
    aws('ec2', 'start-instances', '--instance-ids', s.id);
    console.log('starting...');
    aws('ec2', 'wait', 'instance-running', '--instance-ids', s.id);
    await status();
    break;
  }
  case 'stop': {
    const s = server() ?? die('no server');
    aws('ec2', 'stop-instances', '--instance-ids', s.id);
    console.log(`stopping ${s.id}: compute stops using credits; the disk (and your data) stays.`);
    break;
  }
  case 'smoke': {
    const s = server();
    if (!s?.ip || s.state !== 'running') die('the server is not running: pnpm aws:start');
    const r = spawnSync(
      process.execPath,
      [join(root, 'scripts', 'cloud-smoke.mjs'), '--host', s.ip],
      {
        stdio: 'inherit',
      },
    );
    process.exit(r.status ?? 1);
    break;
  }
  case 'status':
    await status();
    break;
  default:
    die(`unknown command "${command}" (up, status, stop, start, smoke, down)`);
}
