#!/usr/bin/env node
// Runs `pnpm <args>` with the directory of the *current* Node binary first on PATH.
//
// Why: tools that launch dev servers (IDE run configs, the Claude preview pane, Task Scheduler)
// often start with the system PATH, which does not include fnm-managed Node. Starting this file
// with an absolute path to node.exe makes every nested `node`, `tsc` and `next` call use that Node.
//
//   C:\path\to\node.exe scripts/with-node.mjs --filter @modelops/api dev
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';

const nodeDir = dirname(process.execPath);
const env = { ...process.env };
// Windows env var names are case-insensitive but a copied object is not: merge Path/PATH into one.
const pathKeys = Object.keys(env).filter((k) => k.toUpperCase() === 'PATH');
const current = pathKeys.map((k) => env[k]).join(delimiter);
for (const k of pathKeys) delete env[k];
env.PATH = `${nodeDir}${delimiter}${current}`;

// Prefer the pnpm installed next to this Node (pnpm 12 ships a native binary);
// otherwise rely on PATH. No shell is used, so arguments are passed through unmodified.
const pnpmDir = join(nodeDir, 'node_modules', 'pnpm');
const candidates = [
  join(pnpmDir, process.platform === 'win32' ? 'pnpm.exe' : 'pnpm'),
  join(pnpmDir, 'bin', 'pnpm.mjs'),
];
const found = candidates.find((p) => existsSync(p));
const userArgs = process.argv.slice(2);
const [cmd, args] = !found
  ? ['pnpm', userArgs]
  : found.endsWith('.mjs')
    ? [process.execPath, [found, ...userArgs]]
    : [found, userArgs];

const child = spawn(cmd, args, { stdio: 'inherit', env });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
