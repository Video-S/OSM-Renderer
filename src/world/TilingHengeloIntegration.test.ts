import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  OVERIJSSEL_PBF_EXPECTED_SHA256,
  OVERIJSSEL_SNAPSHOT_ID,
  resolveOverijsselIndexPath,
} from '../server/osm/overijsselConfig';
import { runHengeloM1aVerification } from '../../scripts/verify-hengelo-m1a';

test('TKT-028 M1a canonical Hengelo 8x8 SQLite study region (runs only when canonical index exists on disk)', (t) => {
  const indexPath = resolveOverijsselIndexPath();
  if (!fs.existsSync(indexPath)) {
    t.skip(
      `Canonical Overijssel SQLite database not present on disk at ${indexPath}; skipping without download/build.`
    );
    return;
  }

  const res = runHengeloM1aVerification({ indexPath });
  const { report } = res;

  assert.equal(res.snapshotMetadata.snapshotId, OVERIJSSEL_SNAPSHOT_ID);
  assert.equal(res.snapshotMetadata.sourceSha256, OVERIJSSEL_PBF_EXPECTED_SHA256);
  assert.equal(report.tilesProcessed, 64);
  assert.ok(report.nonEmptyTiles > 0);
  assert.equal(report.internalSeamsChecked, 112);

  assert.equal(
    report.defects.length,
    0,
    `Expected 0 seam defects across Hengelo 8x8 grid, got:\n${report.defects
      .slice(0, 15)
      .map((d) => `- [${d.category}] ${d.detail}`)
      .join('\n')}`
  );
  assert.equal(report.isValid, true);
  assert.equal(report.roadIntegrityFailures.length, 0);
  assert.equal(report.buildingParity.missingFromTiles.length, 0);
  assert.equal(report.buildingParity.duplicatedAcrossTiles.length, 0);
  assert.equal(report.buildingParity.triangleMismatches.length, 0);
  assert.equal(report.railwayParity.tiledSleeperCount, report.railwayParity.refSleeperCount);
  assert.ok(report.railwayParity.maxPhaseDiscontinuityU <= 1e-3);
  assert.ok(report.bridgeContinuity.maxDeckElevationDiscontinuityM <= 1e-3);
  assert.equal(report.provenanceParity.missingSourceFeatureIds.length, 0);

  // Confirm 64m collar insufficiency is explicitly audited on real Hengelo data
  assert.equal(report.collarAudit.totalTilesAudited, 64);
  assert.equal(report.collarAudit.isProposedCollarSufficientWithoutGlobalContext, false);
  assert.ok(report.collarAudit.totalInsufficiencyCases > 0);
});
