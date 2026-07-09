import { once } from 'node:events';
import { createWriteStream } from 'node:fs';

async function writeChunk(
  stream: NodeJS.WritableStream,
  chunk: string,
): Promise<void> {
  if (!stream.write(chunk)) await once(stream, 'drain');
}

async function generateFixture(
  outputPath: string,
  targetMegabytes: number,
): Promise<void> {
  const stream = createWriteStream(outputPath);
  const targetBytes = targetMegabytes * 1024 * 1024;
  let writtenBytes = 0;
  let index = 0;

  await writeChunk(
    stream,
    '{"SchemaVersion":2,"Results":[{"Target":"synthetic","Vulnerabilities":[',
  );
  while (writtenBytes < targetBytes) {
    const vulnerability = JSON.stringify({
      VulnerabilityID: `CVE-SYN-${index}`,
      PkgName: 'synthetic-pkg',
      InstalledVersion: '1.0.0',
      Severity: index % 10 === 0 ? 'CRITICAL' : 'LOW',
      Title: 'Synthetic vulnerability for memory fixture',
      PrimaryURL: 'https://example.invalid/cve',
    });
    const chunk = `${index === 0 ? '' : ','}${vulnerability}`;
    await writeChunk(stream, chunk);
    writtenBytes += Buffer.byteLength(chunk);
    index += 1;
  }
  await writeChunk(stream, ']}]}');
  stream.end();
  await once(stream, 'finish');
}

const outputPath = process.argv[2] ?? 'fixtures/generated-large-fixture.json';
const targetMegabytes = Number(process.argv[3] ?? '500');

if (!Number.isFinite(targetMegabytes) || targetMegabytes <= 0) {
  console.error(
    'Usage: npm run gen:fixture -- <output-path> [positive-size-megabytes]',
  );
  process.exit(2);
}

generateFixture(outputPath, targetMegabytes).catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
