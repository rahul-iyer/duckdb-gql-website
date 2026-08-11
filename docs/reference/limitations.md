# Compatibility and limitations

DuckGQL is experimental and implements a growing subset of ISO/IEC 39075:2024
GQL. Parser coverage is not the same as complete language semantics.

## Source of truth

The machine-readable conformance manifest in the extension repository is the
authoritative feature inventory:

- [ISO GQL conformance manifest](https://github.com/rahul-iyer/duckdb-gql/blob/main/test/conformance/iso-gql-2024.tsv)

## Current boundaries

- Lifecycle operations and CSR construction are autocommit-only.
- CSR snapshots are local to the connection that built them.
- Bulk import currently accepts one vertex file and one edge file.
- Bulk import supports at most one scalar vertex-label column and one
  relationship-type column; every edge has exactly one non-empty type.
- Multiple-path and undirected insertion remain incomplete.
- General runtime property maps and open-graph schema evolution remain
  incomplete.
- Path modes, searches, shortest-path groups, query composition, procedure
  semantics, graph types, and the complete GQL value/type system remain
  incomplete.
- DuckLake-backed graphs are read-only and currently map one vertex table and
  one edge table from the same catalog, using integer keys.
- Weighted SSSP is not implemented.

## DuckDB compatibility

DuckDB extension binaries are tied to a DuckDB version and target platform.
Use a DuckGQL artifact built for the exact DuckDB version and architecture you
are running. Development artifacts are unsigned and require an unsigned
extension-enabled DuckDB process.

## Reporting problems

Include the DuckDB version, DuckGQL commit or release, operating system and
architecture, a minimal graph fixture, and the smallest failing statement in a
[GitHub issue](https://github.com/rahul-iyer/duckdb-gql/issues).
