import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';

import { ScanService } from '../scan/scan.service';
import type { CreateScanDto } from './dto/create-scan.dto';
import { ScanResponse, toScanResponse } from './dto/scan-response';
import { GithubUrlPipe } from './validation/github-url.pipe';

/**
 * Thin REST transport adapter over the shared `ScanService` (ARCH-01). Its ONLY
 * collaborator is `ScanService`; `enqueue`/`get` are the only methods it calls.
 * All URL validation lives in `GithubUrlPipe` and all status shaping in
 * `toScanResponse`, so this file MUST NOT import the engine, parser, queue, or
 * any I/O primitive:
 *   - node:fs / fs / node:child_process / child_process / execa
 *   - @nestjs/bullmq / report-parser / engine/*
 * The import-guard in scan.controller.spec.ts enforces this mechanically.
 */
@Controller('api/scan')
export class ScanController {
  constructor(private readonly scans: ScanService) {}

  /**
   * Non-blocking submit: validate (pipe), enqueue, and return the queued
   * identity. Awaits ONLY `enqueue` — no engine work (SCAN-01, D-04).
   */
  @Post()
  @HttpCode(202)
  async create(
    @Body(GithubUrlPipe) body: CreateScanDto,
  ): Promise<{ scanId: string; status: 'Queued' }> {
    const scan = await this.scans.enqueue(body.repoUrl);
    return { scanId: scan.id, status: 'Queued' as const };
  }

  /**
   * Poll a scan by id. Maps the domain state to the wire DTO; an unknown id
   * (service returns null) becomes 404 (SCAN-03/04/05, D-05).
   */
  @Get(':scanId')
  async get(@Param('scanId') scanId: string): Promise<ScanResponse> {
    const scan = await this.scans.get(scanId);
    if (scan === null) {
      throw new NotFoundException();
    }
    return toScanResponse(scan);
  }
}
