import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import {
  OVERIJSSEL_HISTORICAL_BENCHMARK_SHA256,
  OVERIJSSEL_PBF_EXPECTED_BYTES,
  OVERIJSSEL_PBF_EXPECTED_MD5,
  OVERIJSSEL_PBF_EXPECTED_SHA256,
  OVERIJSSEL_PBF_URL,
  parseOverijsselCliOptions,
  resolveOverijsselPbfPath,
} from '../src/server/osm/overijsselConfig';
import { computePbfFileDigests } from '../src/server/osm/OverijsselIndexBuilder';

function formatShaMismatchError(params: {
  context: string;
  filePath: string;
  expectedSha256: string;
  actualSha256: string;
  actualMd5: string;
  actualBytes: number;
  recoveryLines: string[];
}): string {
  const canonicalHint =
    params.expectedSha256 === OVERIJSSEL_PBF_EXPECTED_SHA256
      ? ` (Geofabrik MD5 ${OVERIJSSEL_PBF_EXPECTED_MD5}, ${OVERIJSSEL_PBF_EXPECTED_BYTES.toLocaleString()} bytes)`
      : '';
  const historicalHint =
    params.actualSha256 === OVERIJSSEL_HISTORICAL_BENCHMARK_SHA256
      ? '\n  Note: Actual SHA-256 matches the archived TKT-019/TKT-022 snapshot ("overijssel-261114"), not the current verified Geofabrik snapshot.'
      : '';
  return (
    `${params.context} for "${params.filePath}" (${params.actualBytes.toLocaleString()} bytes):\n` +
    `  Expected SHA-256: ${params.expectedSha256}${canonicalHint}\n` +
    `  Actual SHA-256:   ${params.actualSha256}\n` +
    `  Actual MD5:       ${params.actualMd5}${historicalHint}\n` +
    `Recovery:\n` +
    params.recoveryLines.map((line) => `  - ${line}`).join('\n')
  );
}

export async function fetchOverijsselPbf(options?: {
  outPath?: string;
  fromLocalPath?: string;
  url?: string;
  expectedSha256?: string;
  force?: boolean;
  skipHashCheck?: boolean;
}): Promise<{
  pbfPath: string;
  sha256: string;
  md5: string;
  bytes: number;
  reusedExisting: boolean;
}> {
  const outPath = path.resolve(options?.outPath ?? resolveOverijsselPbfPath());
  const expectedSha256 = (options?.expectedSha256 ?? OVERIJSSEL_PBF_EXPECTED_SHA256).toLowerCase();
  const url = options?.url ?? OVERIJSSEL_PBF_URL;

  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  if (!options?.force && fs.existsSync(outPath)) {
    const existing = await computePbfFileDigests(outPath);
    if (options?.skipHashCheck || existing.sha256 === expectedSha256) {
      console.log(
        `Verified existing Overijssel PBF snapshot at ${outPath} (${(
          existing.bytes /
          (1024 * 1024)
        ).toFixed(1)} MiB, sha256=${existing.sha256.slice(0, 12)}...).`
      );
      return {
        pbfPath: outPath,
        sha256: existing.sha256,
        md5: existing.md5,
        bytes: existing.bytes,
        reusedExisting: true,
      };
    }
    throw new Error(
      formatShaMismatchError({
        context: 'Existing Overijssel PBF failed SHA-256 verification',
        filePath: outPath,
        expectedSha256,
        actualSha256: existing.sha256,
        actualMd5: existing.md5,
        actualBytes: existing.bytes,
        recoveryLines: [
          'Re-download and replace with the verified canonical snapshot: npm run osm:fetch-overijssel -- "--" --force (PowerShell) or npx tsx scripts/fetch-overijssel-pbf.ts --force',
          'Or keep and index this custom snapshot intentionally: npx tsx scripts/setup-overijssel.ts --allow-custom-snapshot (or set $env:OVERIJSSEL_ALLOW_CUSTOM_SNAPSHOT="1" before npm run osm:setup-overijssel)',
        ],
      })
    );
  }

  if (options?.fromLocalPath) {
    const src = path.resolve(options.fromLocalPath);
    if (!fs.existsSync(src)) {
      throw new Error(`Local source PBF not found: ${src}`);
    }
    const srcDigests = await computePbfFileDigests(src);
    if (!options?.skipHashCheck && srcDigests.sha256 !== expectedSha256) {
      throw new Error(
        formatShaMismatchError({
          context: 'Local source PBF failed SHA-256 verification',
          filePath: src,
          expectedSha256,
          actualSha256: srcDigests.sha256,
          actualMd5: srcDigests.md5,
          actualBytes: srcDigests.bytes,
          recoveryLines: [
            `If intentionally installing a custom snapshot, run: npx tsx scripts/setup-overijssel.ts --allow-custom-snapshot --from="${src}"`,
            `PowerShell npm alternative: $env:OVERIJSSEL_ALLOW_CUSTOM_SNAPSHOT="1"; npm run osm:setup-overijssel -- "--" --from="${src}"`,
          ],
        })
      );
    }
    if (src !== outPath) {
      fs.copyFileSync(src, outPath);
    }
    console.log(
      `Installed Overijssel PBF snapshot to ${outPath} (${(
        srcDigests.bytes /
        (1024 * 1024)
      ).toFixed(1)} MiB, sha256=${srcDigests.sha256}).`
    );
    return {
      pbfPath: outPath,
      sha256: srcDigests.sha256,
      md5: srcDigests.md5,
      bytes: srcDigests.bytes,
      reusedExisting: false,
    };
  }

  console.log(`Downloading immutable Overijssel PBF snapshot from:\n  ${url}\n-> ${outPath}`);
  const res = await fetch(url, {
    headers: { 'User-Agent': 'RealWorld3DMapViewer/1.0 (TKT-027 offline snapshot setup)' },
  });
  if (!res.ok || !res.body) {
    throw new Error(`Failed to download ${url}: HTTP ${res.status} ${res.statusText}`);
  }

  const resolvedUrl = res.url && res.url !== url ? `${url} (redirected to ${res.url})` : url;
  const tmpPath = `${outPath}.download.${process.pid}`;
  try {
    const fileStream = fs.createWriteStream(tmpPath);
    await pipeline(Readable.fromWeb(res.body as any), fileStream);
    const actual = await computePbfFileDigests(tmpPath);
    if (!options?.skipHashCheck && actual.sha256 !== expectedSha256) {
      throw new Error(
        formatShaMismatchError({
          context: `Downloaded file from ${resolvedUrl} failed SHA-256 verification (temp file discarded)`,
          filePath: outPath,
          expectedSha256,
          actualSha256: actual.sha256,
          actualMd5: actual.md5,
          actualBytes: actual.bytes,
          recoveryLines: [
            'Verify network stability or Geofabrik mirror status and retry: npm run osm:setup-overijssel',
            `If Geofabrik published an intentional updated snapshot and you choose to trust it locally, download manually and install with: npx tsx scripts/setup-overijssel.ts --allow-custom-snapshot --from="<path-to-pbf>"`,
          ],
        })
      );
    }
    if (fs.existsSync(outPath)) {
      fs.rmSync(outPath, { force: true });
    }
    fs.renameSync(tmpPath, outPath);
    console.log(
      `Downloaded & verified ${outPath} (${(actual.bytes / (1024 * 1024)).toFixed(
        1
      )} MiB, sha256=${actual.sha256}).`
    );
    return {
      pbfPath: outPath,
      sha256: actual.sha256,
      md5: actual.md5,
      bytes: actual.bytes,
      reusedExisting: false,
    };
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
  const cli = parseOverijsselCliOptions();
  fetchOverijsselPbf({
    outPath: cli.outPath ?? cli.pbfPath,
    fromLocalPath: cli.fromLocalPath,
    url: cli.url,
    expectedSha256: cli.expectedSha256,
    force: cli.force,
    skipHashCheck: cli.skipHashCheck || cli.allowCustomSnapshot,
  }).catch((err) => {
    console.error('Error fetching Overijssel PBF:', err?.message ?? err);
    process.exit(1);
  });
}

