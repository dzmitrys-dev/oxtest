/**
 * Fail-closed GitHub-URL allowlist (SCAN-02, D-01/D-02/D-03). This is the first
 * public HTTP attack surface, so the repo URL is parse-then-allowlisted here
 * before it can reach `ScanService.enqueue` (the pipe throws 400 on `null`).
 *
 * This is defense-in-depth SSRF / command-injection control layered on top of
 * Phase 3's `shell: false` argv-array `git clone` (which already closes shell
 * injection): only `https://github.com/{owner}/{repo}[.git]` survives every
 * ordered gate below. Non-HTTP transports (ssh/`git@`, `git://`, `file://`),
 * look-alike hosts (`github.com.evil.com`), embedded credentials, and odd ports
 * are rejected by construction (ASVS V5 / V14). Mirrors the fail-closed sentinel
 * idiom of `config/env.validation.ts` — returns `null` on rejection, never
 * throws.
 */

// [github.com/dead-claudia/github-limits] owner: ≤39 alnum, no leading/trailing
// or double hyphen.
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
// repo: ≤100 of alnum . _ - ; never exactly "." or "..".
const REPO = /^(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/;
// Exact host allowlist — never a suffix/substring match (rejects look-alikes).
const HOSTS = new Set(['github.com', 'www.github.com']);
// DoS guard: cap the raw input length before parsing (T-04-05).
const MAX_URL_LENGTH = 2048;

/**
 * Parse and allowlist a candidate GitHub repository URL.
 *
 * @param input untrusted value from the request body (typed `unknown` on
 *   purpose — a client may send anything).
 * @returns `{ owner, repo }` with an optional trailing `.git` stripped, or
 *   `null` for every rejection (fail-closed; never throws).
 */
export function parseGithubUrl(
  input: unknown,
): { owner: string; repo: string } | null {
  if (
    typeof input !== 'string' ||
    input.length === 0 ||
    input.length > MAX_URL_LENGTH
  ) {
    return null;
  }

  let url: URL;
  try {
    // WHATWG parse: throws on ssh scp-syntax (`git@github.com:o/r`) and garbage.
    url = new URL(input);
  } catch {
    return null;
  }

  if (url.protocol !== 'https:') return null; // rejects http:/git:/file:/ssh:
  if (url.username !== '' || url.password !== '') return null; // no userinfo
  if (url.port !== '') return null; // no non-standard ports
  if (!HOSTS.has(url.hostname)) return null; // exact host; no look-alikes

  const parts = url.pathname.replace(/^\/+/, '').replace(/\/+$/, '').split('/');
  if (parts.length !== 2) return null; // exactly {owner}/{repo}

  const owner = parts[0] ?? '';
  let repo = parts[1] ?? '';
  if (repo.endsWith('.git')) repo = repo.slice(0, -4); // optional .git (D-01)

  if (!OWNER.test(owner) || !REPO.test(repo)) return null;

  return { owner, repo };
}
