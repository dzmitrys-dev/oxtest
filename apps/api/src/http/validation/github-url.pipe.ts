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

    if (parseGithubUrl(repoUrl) === null) {
      throw new BadRequestException(
        'repoUrl must be an https://github.com/{owner}/{repo} URL',
      );
    }

    return { repoUrl: repoUrl as string };
  }
}
