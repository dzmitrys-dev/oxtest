import type { RepoCloner } from './repo-cloner.port';
import {
  createSpawnSubprocessRunner,
  type SubprocessRunner,
} from './subprocess-runner';

/** Production default: HTTPS is the only transport git may use (CR-01). */
export const DEFAULT_GIT_ALLOWED_PROTOCOLS = 'https';

export interface RepoClonerOptions {
  /** Git executable name/path (defaults to `git` resolved on PATH). */
  gitCommand?: string;
  runner?: SubprocessRunner;
  /**
   * Colon-separated git transport allowlist forwarded verbatim as
   * `GIT_ALLOW_PROTOCOL` (CR-01). Validated + injected upstream by the env
   * schema (`SCAN_GIT_ALLOWED_PROTOCOLS`) via the adapter factory. Defaults to
   * `https` so a directly-constructed adapter is fail-closed to HTTPS only.
   */
  allowedProtocols?: string;
}

/**
 * Shallow `git clone` adapter. It consumes the allocator-owned `cloneDir`
 * UNCHANGED and performs an argv-based, `shell:false` shallow clone there. It
 * never generates temp directories or report paths — path ownership belongs
 * exclusively to `ScanPathAllocator` (D-16).
 *
 * The repository URL and destination are passed as discrete argv entries after
 * a `--` end-of-options separator so a hostile URL beginning with `-` cannot be
 * reinterpreted as a git flag (T-03-05). No shell string is ever constructed.
 *
 * The `--` separator defeats flag injection but NOT git's transport layer, so
 * the clone additionally forces a transport allowlist through the environment
 * (CR-01): `GIT_ALLOW_PROTOCOL` behaves as `protocol.allow=never` with only the
 * listed transports set to `always`, and — being an environment variable — it
 * OVERRIDES any `-c protocol.*` config, so the two mechanisms are never mixed.
 * `GIT_PROTOCOL_FROM_USER=0` additionally neutralizes user-policy transports
 * (e.g. `ext::`, the RCE vector), and `GIT_TERMINAL_PROMPT=0` prevents a private
 * repo from hanging on a credential prompt. Production allows only `https`.
 */
export class RepoClonerAdapter implements RepoCloner {
  private readonly gitCommand: string;
  private readonly runner: SubprocessRunner;
  private readonly allowedProtocols: string;

  constructor(options: RepoClonerOptions = {}) {
    this.gitCommand = options.gitCommand ?? 'git';
    this.runner = options.runner ?? createSpawnSubprocessRunner();
    this.allowedProtocols =
      options.allowedProtocols ?? DEFAULT_GIT_ALLOWED_PROTOCOLS;
  }

  async clone(repoUrl: string, cloneDir: string): Promise<void> {
    await this.runner.run(
      this.gitCommand,
      ['clone', '--depth', '1', '--', repoUrl, cloneDir],
      {
        shell: false,
        env: {
          GIT_ALLOW_PROTOCOL: this.allowedProtocols,
          GIT_PROTOCOL_FROM_USER: '0',
          GIT_TERMINAL_PROMPT: '0',
        },
      },
    );
  }
}
