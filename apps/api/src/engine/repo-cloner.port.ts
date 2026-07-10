/**
 * Framework-free clone contract (D-03). No NestJS, Execa, or Node process
 * types leak through the port — only the repository URL and the
 * allocator-owned destination directory.
 *
 * The adapter consumes {@link RepoCloner.clone}'s `cloneDir` UNCHANGED and
 * never generates temporary directories or report paths; path allocation is
 * the exclusive responsibility of the `ScanPathAllocator`.
 */
export interface RepoCloner {
  clone(repoUrl: string, cloneDir: string): Promise<void>;
}

export const REPO_CLONER = Symbol('REPO_CLONER');
