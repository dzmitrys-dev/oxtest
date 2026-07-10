// docker-image-smoke.mjs — gap 05-04 regression guard for CR-01 / CR-02.
//
// The Phase-5 acceptance harness runs the worker via process.execPath ON THE
// HOST (which has git + docker), so it never noticed that the *built image* had
// neither — every in-container scan would have failed ENOENT. This smoke test
// closes that blind spot: it builds the runtime image and asserts, INSIDE it,
// exactly the tools the worker shells out to per scan.
//
// Feasibility-gated (D-06 style): if docker is unavailable, it SKIPS with a
// recorded reason (exit 0) rather than failing — required-when-runnable.
//
// Run: node apps/api/scripts/docker-image-smoke.mjs
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const IMAGE = process.env.SMOKE_IMAGE ?? 'code-guardian-smoke:latest';

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', ...opts });
}

// Feasibility gate: no docker → skip with a recorded reason, do not fail.
if (run('docker', ['version', '--format', '{{.Server.Version}}']).status !== 0) {
  console.log('SKIP: docker daemon unavailable — in-image smoke test skipped (feasibility gate, D-06).');
  process.exit(0);
}

// Build the runtime image (unless a prebuilt SMOKE_IMAGE was supplied).
if (!process.env.SMOKE_IMAGE) {
  const build = run('docker', ['build', '--target', 'runtime', '-t', IMAGE, REPO_ROOT], { stdio: 'inherit' });
  if (build.status !== 0) { console.error('FAIL: docker build failed'); process.exit(1); }
}

// The image ENTRYPOINT drops privileges to `node`, so a plain command runs as node.
const probe = run('docker', ['run', '--rm', IMAGE, 'sh', '-c',
  'printf "uid=%s\\n" "$(id -u)"; git --version; docker --version']);
const out = `${probe.stdout ?? ''}${probe.stderr ?? ''}`;
console.log(out.trim());

const checks = [
  ['runs as non-root node (uid 1000)', /uid=1000/.test(out)],           // D-05
  ['git present (CR-01)', /git version/i.test(out)],                    // clone path
  ['docker CLI present (CR-02)', /Docker version/i.test(out)],          // Trivy sibling path
];
let ok = probe.status === 0;
for (const [label, pass] of checks) {
  console.log(`${pass ? 'PASS' : 'FAIL'}: ${label}`);
  ok = ok && pass;
}

if (!ok) { console.error('FAIL: built image is missing a tool the worker needs — CR-01/CR-02 regression.'); process.exit(1); }
console.log('OK: built image can clone (git) and invoke the sibling scanner (docker) as non-root node.');
process.exit(0);
