'use strict';

const fs = require('fs');
const path = require('path');

function checkpointPath(orgAlias) {
  return path.resolve(process.cwd(), `checkpoint-${orgAlias}.json`);
}

function emptyState(orgAlias, csvPath, workspaceId) {
  return {
    orgAlias,
    csvPath,
    workspaceId,
    phases: {
      1: { status: 'pending', lastBatchIndex: -1, succeeded: 0, failed: 0 },
      2: { status: 'pending', lastBatchIndex: -1, succeeded: 0, failed: 0 },
      3: { status: 'pending', lastBatchIndex: -1, succeeded: 0, failed: 0 },
    },
    uniqueImages: [],
    timestamp: new Date().toISOString(),
  };
}

function load(orgAlias) {
  const file = checkpointPath(orgAlias);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`Could not parse checkpoint ${file}: ${e.message}`);
  }
}

function save(state) {
  state.timestamp = new Date().toISOString();
  const file = checkpointPath(state.orgAlias);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

function backup(orgAlias) {
  const file = checkpointPath(orgAlias);
  if (!fs.existsSync(file)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dst = `${file}.bak-${stamp}`;
  fs.renameSync(file, dst);
  return dst;
}

module.exports = { checkpointPath, emptyState, load, save, backup };
