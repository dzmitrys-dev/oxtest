import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';

import { ScanService } from '../scan/scan.service';
import { parseGithubUrl } from '../http/validation/github-url';
import { toScanModel } from './scan-graphql.mapper';
import { ScanModel } from './scan.model';

/**
 * Thin GraphQL transport adapter over the shared `ScanService` (ARCH-01) — the
 * GraphQL twin of `ScanController`. Its ONLY collaborator is `ScanService`;
 * `get`/`enqueue` are the only methods it calls. Like the REST controller it
 * MUST NOT import the engine, parser, queue, or any I/O primitive:
 *   - node:fs / fs / node:child_process / child_process / execa
 *   - @nestjs/bullmq / report-parser / engine/*
 * The import-guard in scan.resolver.spec.ts enforces this mechanically.
 *
 * SSRF/injection parity (Pitfall 5, T-06-01): the REST path validates via the
 * `GithubUrlPipe`, which is NOT bound to this resolver — so `enqueueScan` calls
 * `parseGithubUrl` itself and enqueues ONLY the canonical
 * `https://github.com/{owner}/{repo}` URL, exactly reproducing the pipe's
 * WR-01 contract. One fail-closed allowlist across BOTH transports.
 */
@Resolver(() => ScanModel)
export class ScanResolver {
  constructor(private readonly scans: ScanService) {}

  /**
   * Poll a scan by id. Returns the mapped model, or `null` when the service
   * returns `null` for an unknown id — GraphQL-nullable-query parity with the
   * REST 404 (the controller throws `NotFoundException`; the query resolves
   * `null`, D-06).
   */
  @Query(() => ScanModel, { nullable: true })
  async scan(
    @Args('id', { type: () => ID }) id: string,
  ): Promise<ScanModel | null> {
    const scan = await this.scans.get(id);
    return scan === null ? null : toScanModel(scan);
  }

  /**
   * Enqueue a scan (parity with `POST /api/scan`). Validates `repoUrl` with the
   * SAME `parseGithubUrl` allowlist as REST and rejects BEFORE `enqueue` runs;
   * on success enqueues the CANONICAL URL (never the raw input) and returns the
   * queued scan mapped to the wire model.
   */
  @Mutation(() => ScanModel)
  async enqueueScan(@Args('repoUrl') repoUrl: string): Promise<ScanModel> {
    const parsed = parseGithubUrl(repoUrl);
    if (parsed === null) {
      throw new Error(
        'repoUrl must be an https://github.com/{owner}/{repo} URL',
      );
    }
    const canonical = `https://github.com/${parsed.owner}/${parsed.repo}`;
    return toScanModel(await this.scans.enqueue(canonical));
  }
}
