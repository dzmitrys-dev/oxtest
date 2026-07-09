import { Module } from '@nestjs/common';
import { ScanStore } from './scan.store';

/**
 * Shared DI seam both AppModule and WorkerModule import. Exporting
 * ScanStore wires the domain types into both the API and worker tiers
 * (RESEARCH.md Architectural Responsibility Map). No HTTP/GraphQL imports.
 */
@Module({
  providers: [ScanStore],
  exports: [ScanStore],
})
export class ScanModule {}
