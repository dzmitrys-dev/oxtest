import { createWriteStream, existsSync, lstatSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { rename, unlink } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { finished } from 'node:stream/promises';

async function writeChunk(
  stream: NodeJS.WritableStream,
  chunk: string,
): Promise<void> {
  if (stream.write(chunk)) return;

  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      stream.removeListener('drain', onDrain);
      stream.removeListener('error', onError);
    };
    const onDrain = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };

    stream.once('drain', onDrain);
    stream.once('error', onError);
  });
}

async function generateFixture(
  outputPath: string,
  targetMegabytes: number,
): Promise<void> {
  const temporaryPath = `${dirname(outputPath)}/.${basename(outputPath)}.tmp-${process.pid}-${randomUUID()}`;
  let stream: ReturnType<typeof createWriteStream> | undefined;
  let committed = false;
  const targetBytes = targetMegabytes * 1024 * 1024;
  let writtenBytes = 0;
  let index = 0;
  let criticalVulnerabilities = 0;

  try {
    stream = createWriteStream(temporaryPath, { flags: 'wx' });
    await writeChunk(
      stream,
      '{"SchemaVersion":2,"Results":[{"Target":"synthetic","Vulnerabilities":[',
    );
    while (writtenBytes < targetBytes) {
      const vulnerability = JSON.stringify({
        VulnerabilityID: `CVE-SYN-${index}`,
        PkgName: 'synthetic-pkg',
        InstalledVersion: '1.0.0',
        Severity:
          index % 10 === 0 ? 'CRITICAL' : index % 10 === 1 ? 'HIGH' : 'LOW',
        Title: 'Synthetic vulnerability for memory fixture',
        PrimaryURL: 'https://example.invalid/cve',
      });
      const chunk = `${index === 0 ? '' : ','}${vulnerability}`;
      await writeChunk(stream, chunk);
      writtenBytes += Buffer.byteLength(chunk);
      if (index % 10 === 0) criticalVulnerabilities += 1;
      index += 1;
    }
    await writeChunk(stream, ']}]}');
    stream.end();
    await finished(stream);
    const bytes = statSync(temporaryPath).size;
    await rename(temporaryPath, outputPath);
    committed = true;
    console.log(JSON.stringify({ outputPath, bytes, vulnerabilities: index, criticalVulnerabilities }));
  } catch (error: unknown) {
    stream?.destroy();
    if (!committed) {
      await unlink(temporaryPath).catch(() => undefined);
    }
    throw error;
  }
}

function parseArguments(argv: string[]): { outputPath: string; targetMegabytes: number } {
  const sizeIndex = argv.indexOf('--size-mb');
  const outputIndex = argv.indexOf('--output');
  const sizeValue = sizeIndex >= 0 ? argv[sizeIndex + 1] : undefined;
  const outputValue = outputIndex >= 0 ? argv[outputIndex + 1] : undefined;
  const targetMegabytes = Number(sizeValue);

  if (
    sizeIndex < 0 ||
    outputIndex < 0 ||
    sizeValue === undefined ||
    outputValue === undefined ||
    !Number.isFinite(targetMegabytes) ||
    !Number.isInteger(targetMegabytes) ||
    targetMegabytes <= 0 ||
    targetMegabytes > 2048 ||
    outputValue.trim() === '' ||
    outputValue.includes('\0')
  ) {
    throw new Error(
      'Usage: gen-fixture --size-mb <positive-size-up-to-2048> --output <file-path>',
    );
  }

  const outputPath = resolve(outputValue);
  if (outputPath === resolve('/')) {
    throw new Error(`Output path must be a file: ${outputValue}`);
  }
  if (existsSync(outputPath)) {
    const outputStats = lstatSync(outputPath);
    if (outputStats.isDirectory() || outputStats.isSymbolicLink()) {
      throw new Error(`Output path must be a regular file path: ${outputValue}`);
    }
  }
  if (!existsSync(dirname(outputPath))) {
    throw new Error(`Output directory does not exist: ${dirname(outputPath)}`);
  }

  return { outputPath, targetMegabytes };
}

async function main(): Promise<void> {
  const { outputPath, targetMegabytes } = parseArguments(process.argv.slice(2));
  await generateFixture(outputPath, targetMegabytes);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
