# Indexes and optimization

DuckGQL keeps DuckDB tables authoritative and chooses graph-aware access paths
during lowering. The final plan can combine native table scans, DuckDB ART
indexes, CSR label postings, selective CSR topology expansion, and batched
fetches back to authoritative rows.

These structures serve different jobs. A property index accelerates selective
vertex predicates. CSR accelerates topology access and algorithms. Neither
replaces the underlying typed tables.

## Start with the query shape

Optimization is most effective when a query exposes selective predicates and
relationship types explicitly:

```sql
MATCH (person:Person)-[:KNOWS]->(friend:Person)
WHERE person.id = 123
RETURN friend.name;
```

This shape gives the planner three useful facts:

- `person.id = 123` may produce a tiny indexed source frontier;
- `Person` limits valid source and target nodes;
- `KNOWS` selects one edge-type fanout distribution.

A disconnected or unfiltered pattern offers fewer opportunities to avoid
large scans.

## Create a vertex property index

```sql
CALL gql_create_property_index('social', 'id');
```

The call returns:

| Column | Meaning |
| --- | --- |
| `success` | Whether the operation completed successfully. |
| `graph_name` | Normalized target graph. |
| `property_name` | Registered vertex property. |
| `index_name` | Generated physical DuckDB index name. |

DuckGQL creates a native DuckDB Adaptive Radix Tree (ART) index over the
managed vertex property column and records it in the graph catalog. Property
names are resolved case-insensitively:

```sql
CALL gql_create_property_index('social', 'ID');
```

Creation is idempotent. If the registered physical index already exists, the
call reuses it rather than creating a duplicate.

### What can be indexed

The current API indexes a mapped vertex property on a managed graph. It rejects:

- unknown graph names;
- properties not mapped on the vertex table;
- ambiguous graph-wide property mappings;
- read-only referenced graphs, including DuckLake-backed mappings.

Referenced source systems should be indexed using their own indexing and
clustering facilities. DuckGQL does not create storage objects inside a
referenced catalog.

Index creation and removal are autocommit-only lifecycle operations. They are
not accepted inside an explicit transaction.

## Inspect property indexes

```sql
SELECT graph_name,
       property_name,
       index_name,
       catalog_name,
       schema_name,
       table_name,
       column_name
FROM gql_property_indexes()
ORDER BY graph_name, property_name;
```

The registration and physical ART index persist across database reopen. DuckDB
maintains the index for both GQL mutations and direct SQL writes to the managed
table.

You can correlate the registration with DuckDB's catalog when diagnosing a
deployment:

```sql
SELECT database_name,
       schema_name,
       table_name,
       index_name,
       sql
FROM duckdb_indexes()
WHERE starts_with(index_name, 'gql_property_index_');
```

## How property lookup is used

DuckGQL recognizes literal equality conjuncts as point-like graph access paths:

```sql
MATCH (person:Person)
WHERE person.id = 123
RETURN person.name;
```

The property index produces candidate element rows. Label membership and all
remaining predicates are still applied, so equal values on another label do
not leak into the result.

An equality nested under `OR` is not treated as a safe candidate restriction:

```sql
MATCH (person:Person)
WHERE person.id = 1 OR person.id = 2
RETURN person.name;
```

The current graph access-path recognizer is intentionally conservative. Range,
substring, list, and arbitrary expression predicates should be expected to use
native DuckDB filtering unless the final DuckDB optimizer independently finds
another applicable path.

An index is most valuable when the equality selects a small fraction of the
vertex table. It adds persistent storage and write-maintenance cost, so index
properties used as lookup keys rather than every property by default.

## Drop a property index

```sql
CALL gql_drop_property_index('social', 'id');
```

Drop is idempotent. If no registration exists, it succeeds without removing an
unrelated object. When present, DuckGQL drops the physical DuckDB index and its
graph-catalog registration atomically.

## Native label and type filtering

Managed node labels are stored as a native `VARCHAR[]` column. A label-only
scan can therefore use DuckDB's vectorized list operation without constructing
a label list per row:

```sql
SELECT *
FROM gql_data.graph_1_vertices
WHERE list_contains(__gql_label, 'person');
```

The physical table name is graph-specific and intended mainly for diagnosis;
normal application queries should use `MATCH (person:Person)`.

Each edge stores one lowercase scalar relationship type. This makes type
filtering and per-type fanout statistics straightforward. For broad graph
queries, DuckDB can scan and join the typed tables directly.

## What a full CSR adds to query planning

Property indexes do not require CSR. When a current full CSR snapshot exists,
the graph access planner may additionally use:

| Access path | Purpose |
| --- | --- |
| Label posting | Produce element IDs carrying a selective node label. |
| Fixed-hop CSR expansion | Expand outgoing or incoming relationships from a small frontier. |
| CSR path expansion | Traverse a bounded or supported unbounded quantified edge. |
| Edge-property hybrid | Generate edge IDs in CSR, then fetch typed edge properties from the authoritative table. |
| Batched vertex/edge fetch | Fetch a small group of canonical rows by CSR-produced element IDs. |

Prepare the full optimizer and inspection snapshot explicitly when a workload
should have these capabilities from its first query:

```sql
CALL gql_build_csr('social');
```

Ordinary `MATCH` does not require CSR. Without a current suitable snapshot it
uses relational scans, joins, and recursive expansion. Graph algorithms build
their own minimal compatible CSR automatically; they no longer require an
explicit `gql_build_csr` setup call.

## Selective expansion versus bulk scans

CSR is not automatically faster for every pattern. A small indexed source is a
strong expansion seed:

```sql
MATCH (source:Person)-[:KNOWS]->(target:Person)
WHERE source.id = 123
RETURN target.name;
```

A full CSR lets the plan perform:

```text
ART equality lookup
    -> source element ID
    -> CSR KNOWS expansion
    -> batched target row fetch
    -> property projection
```

By contrast, a broad frontier can make repeated correlated expansion more
expensive than scanning an edge relation once and letting DuckDB reorder joins.
DuckGQL estimates fanout from per-type CSR statistics and uses heuristics to
choose between selective expansion and a bulk relational path.

For a chain, the planner may use CSR for only the first selective hop and keep
later broad hops in the native join island. A mixed plan is expected behavior,
not evidence that optimization stopped halfway.

## Edge properties remain authoritative

CSR stores topology and optional edge identities, not arbitrary property
payloads. If a query reads or filters an edge property, DuckGQL can use CSR to
generate candidate edge IDs and then fetch the current typed row:

```sql
MATCH (source:Person)-[relationship:KNOWS]->(target:Person)
WHERE source.id = 123
  AND relationship.since >= 2020
RETURN target.name, relationship.since;
```

This hybrid preserves one authoritative property value while avoiding a full
edge scan when the topology frontier is selective.

## Label postings are selective tools

A full CSR contains node-label posting lists. The planner can join those
element IDs back to the vertex table instead of evaluating label membership on
every row.

Posting access is heuristic. A very broad label such as `Person` may be cheaper
as a vectorized table scan, while a rare label combined with a point-like
predicate can be a good posting candidate. Do not assume that building CSR
forces every label predicate through postings.

## Snapshot validity and fallback

CSR is immutable derived state tied to graph and source versions. Managed GQL
mutations and direct writes to managed graph tables invalidate it. A `MATCH`
query then falls back safely to relational access; it does not consume stale
topology.

Algorithm calls rebuild the minimal projection they require. Query workloads
that want full optimizer capabilities again can run:

```sql
CALL gql_build_csr('social');
```

For a live DuckLake mapping, a changed DuckLake snapshot likewise invalidates
prepared CSR. A pinned mapping refuses to query against the wrong attached
snapshot.

## Inspect CSR statistics

```sql
SELECT graph_name,
       vertex_count,
       edge_count,
       memory_bytes,
       build_count,
       has_vertex_label_postings,
       has_edge_stats,
       snapshot_acquisition_count
FROM gql_csr_stats('social');
```

Per-type statistics expose the information used for expansion estimates:

```sql
SELECT edge_label,
       edge_count,
       outgoing_vertex_count,
       incoming_vertex_count,
       avg_outgoing_degree,
       avg_incoming_degree,
       max_outgoing_degree,
       max_incoming_degree
FROM gql_csr_edge_stats('social')
ORDER BY edge_label;
```

These inspection functions require prepared compatible state. Run a full CSR
build first when you need a complete, predictable statistics surface.

## Read the physical plan

Use `EXPLAIN` to confirm the chosen path instead of inferring it from query
text:

```sql
EXPLAIN MATCH (source:Person)-[:KNOWS]->(target:Person)
WHERE source.id = 123
RETURN target.name;
```

Typical plan signals include:

- an index scan for a property lookup;
- `gql_csr_vertices` for label postings;
- `gql_csr_expand` for a fixed hop;
- `gql_csr_path_expand` for quantified expansion;
- `gql_vertex_fetch` or `gql_edge_fetch` for small canonical row batches;
- graph table scans and DuckDB joins for relational access.

```sql
EXPLAIN ANALYZE MATCH (source:Person)-[:KNOWS]->(target:Person)
WHERE source.id = 123
RETURN target.name;
```

`EXPLAIN ANALYZE` executes the query and reports observed operator timing and
cardinality. Compare cold and warm runs separately: the first CSR-consuming
operation may include construction, while later operations can reuse compatible
state.

## Practical tuning sequence

1. Write a semantically precise query with explicit labels, relationship types,
   and selective predicates.
2. Run `EXPLAIN` without adding derived structures.
3. Add a property index only for repeated selective equality lookup.
4. Build full CSR only when the workload benefits from topology expansion,
   label postings, optimizer statistics, or explicit preparation.
5. Re-run `EXPLAIN ANALYZE` and validate result cardinality as well as time.
6. Account for index maintenance and native CSR memory in the operational cost.

The optimizer is heuristic rather than a complete graph cardinality model.
Measure the real graph's label frequencies, fanout, property selectivity, and
frontier sizes before turning a benchmark result into a deployment rule.
