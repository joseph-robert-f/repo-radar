#!/usr/bin/env node
/**
 * Validate the collector's GraphQL documents against GitHub's published schema.
 *
 *   npm i --no-save @octokit/graphql-schema graphql
 *   node scripts/validate-queries.mjs
 *
 * A typo'd field, a wrong enum value, or an argument the API doesn't take
 * otherwise only shows up as a failed workflow run. This catches all of them
 * offline, without a token. It's the one part of collect.mjs that selftest.mjs
 * can't reach.
 *
 * Not wired into the workflow on purpose — it needs dev dependencies, and this
 * repo stays dependency-free. Run it by hand after touching a query.
 */
import { REPOS_QUERY, buildHistoryQuery, buildCompareQuery } from "./collect.mjs";

let schema, parse, validate;
try {
  ({ schema } = await import("@octokit/graphql-schema"));
  ({ parse, validate } = await import("graphql"));
} catch {
  console.error(
    "Missing dev deps. Run:\n  npm i --no-save @octokit/graphql-schema graphql",
  );
  process.exit(1);
}

// The package exports either raw SDL or an { idl } wrapper depending on version.
const { buildSchema } = await import("graphql");
const sdl = typeof schema === "string" ? schema : schema.idl;
// The published schema doesn't pass graphql-js's own strictness checks — a
// duplicate field on an enterprise type, and deprecated fields implementing
// non-deprecated interface fields. None of that is in anything we query, and
// rejecting the whole schema over it would cost us the check entirely. Our
// documents are still validated field-by-field against it.
const gh = buildSchema(sdl, { assumeValid: true, assumeValidSDL: true });

const documents = [
  ["repos query", REPOS_QUERY],
  ["history query (batch of 3)", buildHistoryQuery(3)],
  ["compare query (batch of 3)", buildCompareQuery(3)],
];

let failures = 0;
for (const [name, source] of documents) {
  try {
    const errors = validate(gh, parse(source));
    if (errors.length) {
      failures++;
      console.log(`FAIL ${name}`);
      for (const e of errors) console.log(`       ${e.message}`);
    } else {
      console.log(`ok   ${name}`);
    }
  } catch (err) {
    failures++;
    console.log(`FAIL ${name} — could not parse\n       ${err.message}`);
  }
}

console.log(failures ? `\n${failures} document(s) invalid` : "\nall queries valid");
process.exit(failures ? 1 : 0);
