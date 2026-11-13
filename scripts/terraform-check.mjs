#!/usr/bin/env node
/**
 * terraform-check.mjs: the AWS infrastructure checks (M11), the same locally and in CI.
 *
 *   pnpm tf:check
 *
 * Runs, in pinned containers (nothing to install, no AWS account, no credentials):
 *   1. terraform fmt -check -recursive
 *   2. terraform init -backend=false + validate, for every environment (envs/demo uses every
 *      module; envs/free-plan is the one AWS free-plan server, ADR-0009)
 *   3. tflint --recursive (terraform + AWS rulesets, infra/terraform/.tflint.hcl)
 *   4. checkov: every finding must be fixed or skipped inline with a written reason
 * There is no `terraform plan` or `apply` here, by design (ADR-0008); `pnpm aws:up` applies
 * envs/free-plan with the owner's own credentials (ADR-0009).
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tfDir = join(root, 'infra', 'terraform');
const TERRAFORM =
  'hashicorp/terraform:1.17.1@sha256:a5d5a5a892c98f60fcbfa81eac2a40fc19e7b3fa7719bccae10ff6111d22524a';
const TFLINT =
  'ghcr.io/terraform-linters/tflint:v0.65.0@sha256:2788f4d4fc663c0e953b011b01bf443fe5bfce7587ee916e588e6057b85d6359';
const CHECKOV =
  'bridgecrew/checkov:3.4.3@sha256:bfe9d70bb7f044aba49bd99675813445f106dee6072da583f51008cb667f3a63';
const ENVS = ['demo', 'free-plan'];

// Git Bash on Windows rewrites /paths in arguments; Docker needs them as written.
const env = { ...process.env, MSYS_NO_PATHCONV: '1' };
const token = process.env.GITHUB_TOKEN ? ['-e', 'GITHUB_TOKEN'] : []; // tflint plugin download

const steps = [
  [
    'terraform fmt',
    ['-v', `${tfDir}:/work`, '-w', '/work', TERRAFORM, 'fmt', '-check', '-recursive', '-diff'],
  ],
  // init + validate every environment (envs/demo uses every module; envs/free-plan is ADR-0009)
  ...ENVS.flatMap((e) => [
    [
      `terraform init (${e})`,
      [
        ...['-v', `${tfDir}:/work`, '-v', 'modelops-tf-plugins:/plugins'],
        ...['-e', 'TF_PLUGIN_CACHE_DIR=/plugins', '-w', '/work', TERRAFORM],
        ...[`-chdir=envs/${e}`, 'init', '-backend=false', '-input=false', '-lockfile=readonly'],
      ],
    ],
    [
      `terraform validate (${e})`,
      [
        ...['-v', `${tfDir}:/work`, '-v', 'modelops-tf-plugins:/plugins'],
        ...['-e', 'TF_PLUGIN_CACHE_DIR=/plugins', '-w', '/work', TERRAFORM],
        ...[`-chdir=envs/${e}`, 'validate'],
      ],
    ],
  ]),
  [
    'tflint --init',
    [
      ...['-v', `${tfDir}:/data`, '-v', 'modelops-tflint-plugins:/root/.tflint.d', ...token],
      ...['-w', '/data', TFLINT, '--init', '--config', '/data/.tflint.hcl'],
    ],
  ],
  [
    'tflint',
    [
      ...['-v', `${tfDir}:/data`, '-v', 'modelops-tflint-plugins:/root/.tflint.d'],
      ...['-w', '/data', TFLINT, '--recursive', '--config', '/data/.tflint.hcl'],
    ],
  ],
  [
    'checkov',
    [
      ...['-v', `${tfDir}:/tf:ro`, CHECKOV, '-d', '/tf', '--framework', 'terraform'],
      ...['--quiet', '--compact', '--download-external-modules', 'false'],
    ],
  ],
];

for (const [name, args] of steps) {
  console.log(`\n== ${name}`);
  const r = spawnSync('docker', ['run', '--rm', ...args], { stdio: 'inherit', env });
  if (r.status !== 0) {
    console.error(`terraform-check: ${name} failed (exit ${String(r.status)})`);
    process.exit(r.status ?? 1);
  }
}
console.log('\nterraform-check: fmt, validate, tflint and checkov all passed');
