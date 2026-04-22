'use strict';

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function createProgress(phaseLabel, totalBatches) {
  const start = Date.now();
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;

  return {
    record({ ok = 0, fail = 0, skip = 0 }) {
      succeeded += ok;
      failed += fail;
      skipped += skip;
    },
    print(batchIndex) {
      const elapsed = Date.now() - start;
      const completed = batchIndex + 1;
      const remaining = totalBatches - completed;
      const eta =
        completed > 0 && remaining > 0 ? Math.round((elapsed / completed) * remaining) : 0;
      const etaStr = remaining > 0 ? `~${formatDuration(eta)} remaining` : 'done';
      console.log(
        `[${phaseLabel}] Batch ${completed}/${totalBatches} | ` +
          `OK: ${succeeded} | Fail: ${failed} | Skip: ${skipped} | ` +
          `Elapsed: ${formatDuration(elapsed)} | ${etaStr}`
      );
    },
    summary() {
      return {
        succeeded,
        failed,
        skipped,
        elapsedMs: Date.now() - start,
      };
    },
  };
}

module.exports = { createProgress, formatDuration };
