import { Field, ID, ObjectType } from '@nestjs/graphql';

import { VulnerabilityModel } from './vulnerability.model';

/**
 * Code-first GraphQL mirror of the domain `Scan`, locked by API-01:
 *   type Scan { id: ID!, status: String!, criticalVulnerabilities: [Vulnerability] }
 *
 * `status` is a plain `String!` (NOT a GraphQL enum) per the locked schema —
 * the `ScanStatus` enum VALUE is mapped to its string in `toScanModel`.
 * `criticalVulnerabilities` is a nullable list, populated only when the scan is
 * Finished (D-06 parity with the REST `toScanResponse` mapper). This is a
 * decorated mirror; the framework-free `src/domain/scan.types.ts` is never
 * decorated (D-03).
 */
@ObjectType()
export class ScanModel {
  @Field(() => ID) id!: string;

  @Field() status!: string;

  @Field(() => [VulnerabilityModel], { nullable: true })
  criticalVulnerabilities?: VulnerabilityModel[];
}
