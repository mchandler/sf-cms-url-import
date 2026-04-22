'use strict';

const { execFile, exec } = require('child_process');

const IS_WINDOWS = process.platform === 'win32';
const SF_BIN = IS_WINDOWS ? 'sf.cmd' : 'sf';
const EXEC_OPTS = { maxBuffer: 5 * 1024 * 1024 };
const ORG_ALIAS_RE = /^[A-Za-z0-9_.-]+$/;

function runSf(args) {
  return new Promise((resolve, reject) => {
    const cb = (err, stdout, stderr) => {
      if (err) {
        const msg = stderr && stderr.trim() ? stderr.trim() : err.message;
        return reject(new Error(`sf ${args.join(' ')} failed: ${msg}`));
      }
      resolve(stdout);
    };
    if (IS_WINDOWS) {
      exec(`${SF_BIN} ${args.join(' ')}`, EXEC_OPTS, cb);
    } else {
      execFile(SF_BIN, args, EXEC_OPTS, cb);
    }
  });
}

async function fetchSession(orgAlias) {
  if (!ORG_ALIAS_RE.test(orgAlias)) {
    throw new Error(`Invalid org alias "${orgAlias}" — only letters, digits, dot, dash, underscore allowed`);
  }
  const stdout = await runSf(['org', 'display', '--target-org', orgAlias, '--json']);
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (e) {
    throw new Error(`Could not parse sf org display output: ${e.message}`);
  }
  const result = parsed && parsed.result;
  if (!result || !result.accessToken || !result.instanceUrl) {
    throw new Error(`sf org display did not return accessToken/instanceUrl for org "${orgAlias}"`);
  }
  return {
    accessToken: result.accessToken,
    instanceUrl: result.instanceUrl.replace(/\/$/, ''),
    username: result.username || null,
  };
}

function createSession(orgAlias) {
  let cached = null;
  return {
    orgAlias,
    async get() {
      if (!cached) cached = await fetchSession(orgAlias);
      return cached;
    },
    async refresh() {
      cached = await fetchSession(orgAlias);
      return cached;
    },
  };
}

module.exports = { createSession };
