'use strict';

const { API_VERSION, sleep } = require('./http');
const { createProgress } = require('./progress');
const { save: saveCheckpoint } = require('./checkpoint');

const PUBLISH_BATCH_SIZE = 200;

async function runPhase2({ client, state, paceMs, errorLog, force }) {
  const phaseState = state.phases[2];
  if (phaseState.status === 'completed' && !force) {
    console.log('[Phase 2] Already completed (checkpoint). Use --force to re-run.');
    return phaseState;
  }
  phaseState.status = 'in_progress';

  const ids = state.uniqueImages.map((e) => e.managedContentId).filter(Boolean);
  if (ids.length === 0) {
    console.log('[Phase 2] No managedContentIds to publish (Phase 1 produced none).');
    phaseState.status = 'completed';
    saveCheckpoint(state);
    return phaseState;
  }

  const totalBatches = Math.ceil(ids.length / PUBLISH_BATCH_SIZE);
  const progress = createProgress('Phase 2', totalBatches);
  console.log(`[Phase 2] ${ids.length} content IDs to publish across ${totalBatches} batches`);

  for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
    if (batchIndex <= phaseState.lastBatchIndex && !force) continue;

    const chunk = ids.slice(batchIndex * PUBLISH_BATCH_SIZE, (batchIndex + 1) * PUBLISH_BATCH_SIZE);

    try {
      await client.post(`/services/data/${API_VERSION}/connect/cms/contents/publish`, {
        description: 'Bulk publish product images',
        contentIds: chunk,
      });
      progress.record({ ok: chunk.length });
      phaseState.succeeded += chunk.length;
    } catch (e) {
      console.error(`[Phase 2] Batch ${batchIndex + 1} publish failed: ${e.message}`);
      progress.record({ fail: chunk.length });
      phaseState.failed += chunk.length;
      for (const id of chunk) {
        errorLog.log({
          phase: 2,
          errorCode: 'PUBLISH_FAILED',
          errorMessage: `${id}: ${e.message}`.slice(0, 500),
        });
      }
    }

    phaseState.lastBatchIndex = batchIndex;
    saveCheckpoint(state);
    progress.print(batchIndex);

    if (paceMs > 0 && batchIndex + 1 < totalBatches) await sleep(paceMs);
  }

  phaseState.status = 'completed';
  saveCheckpoint(state);
  const sum = progress.summary();
  console.log(`[Phase 2] Done. Published: ${sum.succeeded} | Failed: ${sum.failed}`);
  return phaseState;
}

module.exports = { runPhase2 };
