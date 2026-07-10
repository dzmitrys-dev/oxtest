import { BadRequestException, Injectable } from '@nestjs/common';
import type { PipeTransform } from '@nestjs/common';

import type { CreateScanDto } from '../dto/create-scan.dto';
import { parseGithubUrl } from './github-url';

/**
 * Transport-boundary pipe enforcing the D-03 "400 before enqueue" contract.
 *
 * A NestJS pipe runs BEFORE the controller handler body, so binding this on the
 * `POST /api/scan` body structurally guarantees that a malformed / non-GitHub /
 * missing URL yields HTTP 400 and `ScanService.enqueue` is never reached — even
 * for an entirely `undefined` body (Pitfall 4). Imports ONLY `@nestjs/common`
 * plus the pure validator + DTO — never `@nestjs/bullmq`, `ScanService`, `fs`,
 * or `child_process` (ARCH-01).
 */
@Injectable()
export class GithubUrlPipe implements PipeTransform<unknown, CreateScanDto> {
  transform(value: unknown): CreateScanDto {
    const repoUrl =
      typeof value === 'object' && value !== null
        ? (value as Record<string, unknown>).repoUrl
        : undefined;

    const parsed = parseGithubUrl(repoUrl);
    if (parsed === null) {
      throw new BadRequestException(
        'repoUrl must be an https://github.com/{owner}/{repo} URL',
      );
    }

    // WR-01 (D-13): return the CANONICAL form built from the parsed parts, not
    // the raw request string. This makes the enqueued/cloned URL provably equal
    // to what was validated — closing the validate-vs-use parser differential
    // (`.git` suffix, `www.` host, trailing slash all normalized here; V5 /
    // T-05-01-03).
    return { repoUrl: `https://github.com/${parsed.owner}/${parsed.repo}` };
  }
}
