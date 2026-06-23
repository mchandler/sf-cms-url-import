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

function parseSfJson(stdout, label) {
  try {
    return JSON.parse(stdout);
  } catch (e) {
    throw new Error(`Could not parse ${label} output: ${e.message}`);
  }
}

// A real SF access token is a single opaque string with no whitespace. Newer
// CLI versions REDACT it in `sf org display --json`, returning the literal
// "[REDACTED] Use 'sf org auth show-access-token' to view" — which contains
// spaces and the word REDACTED. Anything matching those is not a usable token.
function looksLikeRealToken(value) {
  return typeof value === 'string'
    && value.length > 0
    && !/\s/.test(value)
    && !/REDACTED/i.test(value);
}

async function fetchSession(orgAlias) {
  if (!ORG_ALIAS_RE.test(orgAlias)) {
    throw new Error(`Invalid org alias "${orgAlias}" — only letters, digits, dot, dash, underscore allowed`);
  }
  // `sf org display --json` gives us instanceUrl + username (never redacted)
  // and, on OLDER CLI versions, the real accessToken too. On NEWER versions
  // the token comes back redacted, so we fall back to
  // `sf org auth show-access-token` — which older CLIs don't have. Trying
  // display first and only falling back when the token is redacted keeps this
  // working across CLI versions (the fallback subcommand is never invoked on
  // CLIs that lack it).
  const displayOut = await runSf(['org', 'display', '--target-org', orgAlias, '--json']);
  const display = parseSfJson(displayOut, 'sf org display');
  const result = display && display.result;
  if (!result || !result.instanceUrl) {
    throw new Error(`sf org display did not return instanceUrl for org "${orgAlias}"`);
  }

  let accessToken = result.accessToken;
  if (!looksLikeRealToken(accessToken)) {
    // Token was redacted (newer CLI). Pull the real one from the dedicated
    // subcommand. --no-prompt skips its interactive security confirmation.
    const tokenOut = await runSf([
      'org', 'auth', 'show-access-token', '--target-org', orgAlias, '--no-prompt', '--json',
    ]);
    const token = parseSfJson(tokenOut, 'sf org auth show-access-token');
    accessToken = token && token.result && token.result.accessToken;
  }

  if (!looksLikeRealToken(accessToken)) {
    throw new Error(`Could not obtain a usable access token for org "${orgAlias}"`);
  }

  return {
    accessToken,
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
