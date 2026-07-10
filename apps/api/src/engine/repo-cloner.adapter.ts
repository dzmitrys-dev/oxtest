import type { RepoCloner } from './repo-cloner.port';
import {
  createSpawnSubprocessRunner,
  type SubprocessRunner,
} from './subprocess-runner';

export interface RepoClonerOptions {
  /** Git executable name/path (defaults to `git` resolved on PATH). */
  gitCommand?: string;
  runner?: SubprocessRunner;
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
 */
export class RepoClonerAdapter implements RepoCloner {
  private readonly gitCommand: string;
  private readonly runner: SubprocessRunner;

  constructor(options: RepoClonerOptions = {}) {
    this.gitCommand = options.gitCommand ?? 'git';
    this.runner = options.runner ?? createSpawnSubprocessRunner();
  }

  async clone(repoUrl: string, cloneDir: string): Promise<void> {
    await this.runner.run(
      this.gitCommand,
      ['clone', '--depth', '1', '--', repoUrl, cloneDir],
      { shell: false },
    );
  }
}
