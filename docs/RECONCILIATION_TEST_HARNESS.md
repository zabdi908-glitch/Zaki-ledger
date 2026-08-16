# Reconciliation Test Harness

The promotion harness deliberately uses two commands. Both are run from
`zakiledger/`; neither reads hosted credentials or requires shell environment
edits between groups.

## Unit suite

```bash
npm run test:unit
```

`vitest.config.ts` supplies deterministic dummy OpenAI, Anthropic, and Supabase
values. The command runs all pure/unit and in-memory suites and explicitly
excludes the seven local-DB integration files. There are no expected skips from
missing Supabase environment variables because DB suites are not collected.

## Fresh-local DB integration suite

Precondition: Docker and the Supabase CLI are installed, and the local stack for
this repository has been started and freshly reset from the repository root:

```bash
supabase start
supabase db reset --local
```

Then run from `zakiledger/`:

```bash
npm run test:local-db
```

The command first checks the local project with `supabase status --workdir ..`.
`vitest.local.config.ts` then pins all DB/API endpoints and credentials to the
standard local stack (`127.0.0.1:54321` and `127.0.0.1:54322`) and runs only:

- migration 012 contract and tenant-isolation suites;
- migration 013 contract suite;
- reconciliation schema-compatibility suite in canonical-012 mode;
- defect-regression and supersession/concurrency coverage;
- controlled approval and audit attack coverage;
- direct manual-override attack coverage.

Expected skips: the eight pre-012/011 cases inside the schema-compatibility
suite are skipped because a fresh 001→013 database is canonical-012-compatible;
its eight canonical-012 cases run. No whole integration file should skip. The
command never uses a hosted URL and its fixed test environment overrides
developer shell values.

The local reset is intentionally a separate promotion step: tests may create
rollback/admin-only adversarial fixtures, and a fresh reset proves that no
manual patch or grant is required.
