---
layout: home

hero:
  name: DuckGQL
  text: Graph queries in DuckDB
  tagline: Query property graphs with GQL, keep DuckDB tables authoritative, and opt into CSR acceleration for graph algorithms.
  actions:
    - theme: brand
      text: Get started
      link: /getting-started
    - theme: alt
      text: Open playground
      link: https://duckgql.com/
    - theme: alt
      text: View on GitHub
      link: https://github.com/rahul-iyer/duckdb-gql

features:
  - title: GQL over DuckDB
    details: Use graph pattern matching, filtering, aggregation, mutation, and path queries while DuckDB executes the relational work.
  - title: Native storage
    details: Vertices and edges remain typed DuckDB tables. Properties are columns, nodes retain label lists, and every edge has one relationship type.
  - title: Optional acceleration
    details: Add native property indexes for selective lookups and build a connection-local CSR snapshot for graph algorithms and selective expansion.
  - title: DuckLake analytics
    details: Map selected DuckLake columns to a typed, read-only graph and choose live data or a pinned snapshot for reproducible analysis.
---

::: warning Experimental
DuckGQL implements a growing subset of ISO/IEC 39075:2024 GQL. Grammar
recognition does not imply semantic or transactional conformance. Check the
[compatibility page](./reference/limitations.md) before relying on a feature.
:::
