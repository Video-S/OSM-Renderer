import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import {
  OVERIJSSEL_PBF_EXPECTED_SHA256,
  OVERIJSSEL_PBF_URL,
  resolveOverijsselPbfPath,
} from '../src/server/osm/overijsselConfig';

async function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath, { highWaterMark: 4 * 1024 * 1024 });
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

export async function fetchOverijsselPbf(options?: {
  outPath?: string;
  fromLocalPath?: string;
  url?: string;
  expectedSha256?: string;
  force?: boolean;
  skipHashCheck?: boolean;
}): Promise<{ pbfPath: string; sha256: string; bytes: number; reusedExisting: boolean }> {
  const outPath = path.resolve(options?.outPath ?? resolveOverijsselPbfPath());
  const expectedSha256 = options?.expectedSha256 ?? OVERIJSSEL_PBF_EXPECTED_SHA256;
  const url = options?.url ?? OVERIJSSEL_PBF_URL;

  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  if (!options?.force && fs.existsSync(outPath)) {
    const existingSha = await sha256File(outPath);
    if (options?.skipHashCheck || existingSha === expectedSha256) {
      const stat = fs.statSync(outPath);
      console.log(
        `Verified existing Overijssel PBF snapshot at ${outPath} (${(
          stat.size /
          (1024 * 1024)
        ).toFixed(1)} MiB, sha256=${existingSha.slice(0, 12)}...).`
      );
      return { pbfPath: outPath, sha256: existingSha, bytes: stat.size, reusedExisting: true };
    }
    throw new Error(
      `Existing PBF at ${outPath} failed SHA-256 verification (expected ${expectedSha256}, got ${existingSha}). Re-run with --force to replace it.`
    );
  }

  if (options?.fromLocalPath) {
    const src = path.resolve(options.fromLocalPath);
    if (!fs.existsSync(src)) {
      throw new Error(`Local source PBF not found: ${src}`);
    }
    const srcSha = await sha256File(src);
    if (!options?.skipHashCheck && srcSha !== expectedSha256) {
      throw new Error(
        `Source PBF ${src} SHA-256 mismatch: expected ${expectedSha256}, got ${srcSha}.`
      );
    }
    if (src !== outPath) {
      fs.copyFileSync(src, outPath);
    }
    const stat = fs.statSync(outPath);
    console.log(
      `Installed Overijssel PBF snapshot to ${outPath} (${(
        stat.size /
        (1024 * 1024)
      ).toFixed(1)} MiB, sha256=${srcSha}).`
    );
    return { pbfPath: outPath, sha256: srcSha, bytes: stat.size, reusedExisting: false };
  }

  console.log(`Downloading immutable Overijssel PBF snapshot from:\n  ${url}\n-> ${outPath}`);
  const res = await fetch(url, {
    headers: { 'User-Agent': 'RealWorld3DMapViewer/1.0 (TKT-022 offline snapshot setup)' },
  });
  if (!res.ok || !res.body) {
    throw new Error(`Failed to download ${url}: HTTP ${res.status} ${res.statusText}`);
  }

  const tmpPath = `${outPath}.download.${process.pid}`;
  try {
    const fileStream = fs.createWriteStream(tmpPath);
    await pipeline(Readable.fromWeb(res.body as any), fileStream);
    const actualSha = await sha256File(tmpPath);
    if (!options?.skipHashCheck && actualSha !== expectedSha256) {
      throw new Error(
        `Downloaded file SHA-256 mismatch for ${url}: expected ${expectedSha256}, got ${actualSha}.`
      );
    }
    if (fs.existsSync(outPath)) {
      fs.rmSync(outPath, { force: true });
    }
    fs.renameSync(tmpPath, outPath);
    const stat = fs.statSync(outPath);
    console.log(
      `Downloaded & verified ${outPath} (${(stat.size / (1024 * 1024)).toFixed(
        1
      )} MiB, sha256=${actualSha}).`
    );
    return { pbfPath: outPath, sha256: actualSha, bytes: stat.size, reusedExisting: false };
  } catch (err) {
    if (fs.existsSync(tmpPath)) {
      fs.rmSync(tmpPath, { force: true });
    }
    throw err;
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  let outPath: string | undefined;
  let fromLocalPath: string | undefined;
  let url: string | undefined;
  let force = false;
  let skipHashCheck = false;
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--out=')) outPath = arg.slice('--out='.length).trim();
    else if (arg.startsWith('--from=')) fromLocalPath = arg.slice('--from='.length).trim();
    else if (arg.startsWith('--url=')) url = arg.slice('--url='.length).trim();
    else if (arg === '--force') force = true;
    else if (arg === '--skip-hash-check') skipHashCheck = true;
  }

  fetchOverijsselPbf({ outPath, fromLocalPath, url, force, skipHashCheck }).catch((err) => {
    console.error('Error fetching Overijssel PBF:', err?.message ?? err);
    process.exit(1);
  });
}
