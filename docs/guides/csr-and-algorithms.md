# CSR and graph algorithms

DuckDB tables are the authoritative graph storage. DuckGQL builds an immutable
compressed sparse row (CSR) snapshot when an algorithm or adjacency operation
needs topology-oriented access. The snapshot is a derived cache: it can be
rebuilt from the tables and is never a second source of truth.

This guide covers the execution model and every algorithm currently exposed by
DuckGQL.

## How algorithm calls work

The simplest form returns every output column:

```sql
CALL algo.degree('social');
```

Use the GQL `YIELD`/`RETURN` pipeline to select, order, and limit results:

```sql
CALL algo.pagerank('social')
YIELD vertex_id, rank
RETURN vertex_id, rank
ORDER BY rank DESC
LIMIT 10;
```

The algorithms are also table functions in the `system.algo` schema. This form
is useful when ordinary SQL aggregation is more convenient:

```sql
SELECT count(*) AS component_count
FROM (
    SELECT DISTINCT component_id
    FROM system.algo.wcc('social')
);
```

Algorithm inputs and outputs use graph element IDs. A stored business key such
as `customer_id` is not necessarily an element ID. When the starting vertex
comes from `MATCH`, pass `element_id(variable)`:

```sql
MATCH (seed:Person)
FILTER seed.name = 'Ada'
CALL algo.bfs('social', element_id(seed))
YIELD vertex_id, depth
RETURN vertex_id, depth
ORDER BY depth, vertex_id;
```

The rows produced by a preceding `MATCH` form the input frontier for BFS and
DFS. SSSP requires exactly one distinct source. Graph-wide algorithms such as
PageRank execute once after the preceding relation has been consumed.

### Choose an algorithm

| Goal | Algorithm | Direction model | Important output |
| --- | --- | --- | --- |
| Explore in layers | `algo.bfs` | `out`, `in`, or `both` | `depth`, parent tree |
| Explore depth-first | `algo.dfs` | `out`, `in`, or `both` | DFS tree and visit order |
| Distances from one source | `algo.sssp` | `out`, `in`, or `both` | unweighted distance |
| One source-to-target distance | `algo.shortest_path_length` | outgoing | scalar distance |
| Rank linked vertices | `algo.pagerank` | directed | normalized rank |
| Ignore direction and find islands | `algo.wcc` | weak/undirected connectivity | component ID and size |
| Find mutually reachable regions | `algo.scc` | directed | component ID and size |
| Count incident relationships | `algo.degree` | directed | in/out/total degree |
| Rank by path proximity | `algo.closeness` | `out`, `in`, or `both` | generalized closeness |
| Count closed triples | `algo.triangle_count` | simple undirected projection | triangle counts |
| Measure directed neighborhood closure | `algo.lcc` | Graphalytics directed semantics | local coefficient |
| Detect modular communities | `algo.louvain` | simple undirected projection | community and modularity |

## Projection controls shared by algorithms

Most algorithms accept `vertex_label` and `edge_label` filters. They compose:

```sql
CALL algo.degree(
    'social',
    vertex_label := 'Person',
    edge_label := 'FOLLOWS'
);
```

`vertex_label` creates an induced vertex projection. Only vertices with that
label are returned, and an edge participates only when both endpoints remain in
the projection. A traversal source or target outside the projection is an
error. A label that selects no vertices produces no rows for graph-wide
algorithms.

`edge_label` retains only edges with that label. Label matching is
case-insensitive. These filters affect the graph seen by the algorithm; they
are not filters applied after a full-graph result has been computed.

Algorithms with a `direction` parameter accept:

- `out` — follow source-to-destination edges; this is the default.
- `in` — follow edges from destination back to source.
- `both` — visit outgoing and incoming adjacency as one traversable
  neighborhood.

Parallel edges and self-loops are preserved unless an algorithm explicitly
documents a simple-graph projection. This distinction matters: `degree` and
PageRank operate on edge incidences, while triangle counting and Louvain
coalesce parallel and reciprocal relationships.

## Traversal and shortest paths

### Breadth-first search (`algo.bfs`)

BFS visits the source at depth 0 and then emits reachable vertices in
nondecreasing depth. The parent columns form a shortest-path tree in an
unweighted graph.

```sql
CALL algo.bfs(
    'social',
    42,
    direction := 'out',
    max_depth := 4,
    edge_label := 'FOLLOWS',
    vertex_label := 'Person',
    target_vertex_id := 9001
);
```

Parameters:

| Parameter | Default | Meaning |
| --- | --- | --- |
| `graph` | required | Graph name. |
| `frontier` | required | Start element ID, or IDs supplied by a preceding `MATCH`. |
| `direction` | `out` | Adjacency direction to traverse. |
| `max_depth` | unlimited | Greatest emitted depth. Must be non-negative. |
| `edge_label` | all edges | Restricts traversable edges. |
| `vertex_label` | all vertices | Restricts traversal to an induced vertex projection. |
| `target_vertex_id` | none | Stop after the target is emitted. |

Outputs:

| Column | Meaning |
| --- | --- |
| `vertex_id` | Visited vertex element ID. |
| `depth` | Number of edges from its source. |
| `parent_vertex_id` | Predecessor in the BFS tree; `NULL` for a source. |
| `edge_id` | Edge used to discover the vertex; `NULL` for a source. |
| `visit_order` | Zero-based deterministic emission order. |

With multiple source rows from `MATCH`, DuckGQL performs one multi-source BFS.
Each distinct source begins at depth 0. `target_vertex_id` bounds work but does
not reconstruct the full path by itself; follow `parent_vertex_id` and
`edge_id` through the returned tree when path reconstruction is needed.

Typical cost is `O(V + E)` over the reachable projection, with less work when
`max_depth` or a target stops the traversal early.

### Depth-first search (`algo.dfs`)

DFS follows one branch as far as possible before backtracking. It uses an
iterative stack, so deep graphs do not depend on the C++ call stack.

```sql
CALL algo.dfs(
    'social',
    42,
    direction := 'both',
    max_depth := 6
)
YIELD vertex_id, depth, parent_vertex_id, edge_id, visit_order
RETURN vertex_id, depth, parent_vertex_id, edge_id, visit_order;
```

DFS accepts the same traversal controls as BFS. Its output schema is also the
same, but `depth` belongs to the DFS tree and is not a shortest-path distance.
Use DFS for reachability, exhaustive exploration, or tree construction; use
BFS/SSSP when minimum hop count matters.

Traversal order follows deterministic CSR adjacency order. A target stops when
DFS first discovers it, which need not be along a shortest path. Typical cost
is `O(V + E)` over the visited projection.

### Unweighted single-source shortest paths (`algo.sssp`)

SSSP computes minimum hop counts from exactly one source. It is implemented as
a breadth-first traversal because every edge has unit cost.

```sql
CALL algo.sssp(
    'social',
    42,
    direction := 'out',
    edge_label := 'FOLLOWS'
)
YIELD vertex_id, distance, parent_vertex_id
RETURN vertex_id, distance, parent_vertex_id
ORDER BY distance, vertex_id;
```

The controls are `direction`, `max_depth`, `edge_label`, `vertex_label`, and
`target_vertex_id`, with the same defaults as BFS. Output columns are:

| Column | Meaning |
| --- | --- |
| `vertex_id` | Reached vertex. |
| `distance` | Minimum number of edges from the source. |
| `parent_vertex_id` | Predecessor in the shortest-path tree. |
| `edge_id` | Relationship used to settle the vertex. |
| `settled_order` | Zero-based order in which results were settled. |

Unreachable vertices do not appear. Edge properties are not interpreted as
weights, so this is not Dijkstra's algorithm. Weighted SSSP is not currently
implemented.

### One shortest-path length (`algo.shortest_path_length`)

Use this procedure when only one source-to-target hop count is needed. It runs
target-aware outgoing BFS and returns one row.

```sql
MATCH (source:Person), (target:Person)
FILTER source.name = 'Ada' AND target.name = 'Grace'
CALL algo.shortest_path_length(
    'social',
    element_id(source),
    element_id(target),
    'Person',
    'FOLLOWS'
)
YIELD distance
RETURN distance;
```

The optional fourth and fifth arguments are `vertex_label` and `edge_label`.
The procedure follows outgoing edges; it has no `direction` option. Distance is
the number of edges, `0` when source equals target, and `-1` when the target is
unreachable. The matched input must identify exactly one distinct source and
one distinct target.

## Ranking and centrality

### PageRank (`algo.pagerank`)

PageRank assigns more score to vertices receiving links from other highly
ranked vertices. DuckGQL uses the directed projected graph, redistributes score
from dangling vertices, and keeps scores normalized to approximately 1 for a
non-empty projection.

```sql
CALL algo.pagerank(
    'social',
    damping := 0.85,
    max_iterations := 100,
    tolerance := 1e-8,
    edge_label := 'FOLLOWS',
    vertex_label := 'Person'
)
YIELD vertex_id, rank, iterations, converged
RETURN vertex_id, rank, iterations, converged
ORDER BY rank DESC
LIMIT 20;
```

| Parameter | Default | Meaning |
| --- | --- | --- |
| `damping` | `0.85` | Probability of following an edge. Must be strictly between 0 and 1. |
| `max_iterations` | `100` | Positive iteration cap. |
| `tolerance` | `1e-8` | Positive finite L1 score-difference threshold. |
| `edge_label` | all edges | Relationships that transfer rank. |
| `vertex_label` | all vertices | Induced vertex projection on which rank is normalized. |

`iterations` and `converged` describe the entire run and are repeated on every
vertex row. `converged = false` means the iteration limit was reached before
the requested tolerance; the returned scores are still the final iterate.

At one DuckDB thread, PageRank uses an outgoing push loop for sequential
locality. With multiple threads it uses incoming-edge pull tasks plus compact
out-degree data. Each iteration costs `O(V + E)` on the projection.

### Closeness centrality (`algo.closeness`)

Closeness ranks vertices by their shortest-path distance to other reachable
vertices. DuckGQL computes exact, unweighted generalized closeness for
disconnected graphs.

```sql
SELECT vertex_id, reachable_count, distance_sum, closeness_centrality
FROM system.algo.closeness(
    'social',
    direction := 'out',
    edge_label := 'FOLLOWS',
    vertex_label := 'Person'
)
ORDER BY closeness_centrality DESC;
```

For a projected graph with `N` vertices, let `r` be the number of other
vertices reachable from a source and `d` the sum of their shortest-path
distances. The reported score is:

```text
r^2 / ((N - 1) * d)
```

The score is 0 when no other vertex is reachable. This is the
Wasserman–Faust-style normalization: inverse average distance is penalized when
much of the graph is unreachable. `direction` defaults to `out`; `in` measures
how easily a vertex can be reached by reversing edges, and `both` ignores edge
orientation for reachability.

Closeness runs a BFS from every projected vertex, with worst-case cost
`O(V * (V + E))`. It is exact but can be substantially more expensive than the
other algorithms on large graphs.

## Components and communities

### Weakly connected components (`algo.wcc`)

WCC groups vertices connected after ignoring edge direction. It answers
questions such as “how many disconnected islands exist?”

```sql
CALL algo.wcc('social', edge_label := 'FOLLOWS')
YIELD vertex_id, component_id, component_size
RETURN vertex_id, component_id, component_size
ORDER BY component_size DESC, component_id, vertex_id;
```

`component_id` is stable and deterministic: it is the smallest stored element
ID in the component. Isolated vertices form components of size 1. Parallel
edges and self-loops do not change membership. WCC is near-linear in `V + E`.

### Strongly connected components (`algo.scc`)

SCC preserves direction. Two vertices belong to the same component only when
each is reachable from the other.

```sql
CALL algo.scc('social', vertex_label := 'Person')
YIELD vertex_id, component_id, component_size
RETURN vertex_id, component_id, component_size
ORDER BY component_size DESC, component_id, vertex_id;
```

As with WCC, `component_id` is the smallest stored element ID in the component.
DuckGQL performs iterative forward and reverse traversals over outgoing and
incoming CSR. Cost is `O(V + E)` for the projection.

Use WCC when edge orientation should not split a connected region; use SCC to
find directed cycles or mutually reachable regions.

### Louvain community detection (`algo.louvain`)

Louvain detects communities by greedily improving modularity and repeatedly
coarsening the graph. DuckGQL's implementation is deterministic, classical
multilevel Louvain.

```sql
CALL algo.louvain(
    'social',
    resolution := 1.0,
    max_iterations := 32,
    max_levels := 32,
    tolerance := 1e-12,
    edge_label := 'FOLLOWS',
    vertex_label := 'Person'
)
YIELD vertex_id, community_id, community_size, modularity, levels, iterations, converged
RETURN vertex_id, community_id, community_size, modularity, levels, iterations, converged
ORDER BY community_size DESC, community_id, vertex_id;
```

| Parameter | Default | Meaning |
| --- | --- | --- |
| `resolution` | `1.0` | Positive finite modularity resolution. Higher values generally favor smaller communities. |
| `max_iterations` | `32` | Positive local-move pass limit at each level. |
| `max_levels` | `32` | Positive graph-coarsening level limit. |
| `tolerance` | `1e-12` | Non-negative finite minimum modularity gain. |
| `edge_label` | all edges | Edges retained before building the Louvain projection. |
| `vertex_label` | all vertices | Induced vertex projection. |

Louvain operates on an unweighted simple-undirected projection. Reciprocal and
parallel edges coalesce into one adjacency, and self-loops are ignored. Edge
weights are not currently read from graph properties.

`community_id` is the smallest original vertex ID assigned to that community,
which makes IDs stable for a fixed input and configuration. `modularity`,
`levels`, `iterations`, and `converged` describe the whole run and repeat on
each row. `converged = false` means a local-move or coarsening limit was hit.

Louvain is heuristic: a high modularity partition is not guaranteed to be the
global optimum, and changing `resolution` can materially change the result. It
is not Leiden and does not provide Leiden's stronger community-connectivity
guarantees. The current implementation is serial, so validate runtime and
memory on the intended graph size before adopting it for a large workload.

## Degree, triangles, and clustering

### Degree (`algo.degree`)

Degree counts relationship incidences without simplifying the graph.

```sql
CALL algo.degree('social', edge_label := 'FOLLOWS')
YIELD vertex_id, out_degree, in_degree, total_degree
RETURN vertex_id, out_degree, in_degree, total_degree
ORDER BY total_degree DESC, vertex_id;
```

`out_degree` counts projected edges for which the vertex is the source;
`in_degree` counts projected edges for which it is the destination; and
`total_degree` is their sum. Parallel edges count separately. A self-loop
contributes one to both in-degree and out-degree, and therefore two to total
degree.

Without label filters, degree can read counts directly from CSR offsets. With
an edge or vertex projection it scans participating adjacency, giving typical
cost up to `O(V + E)`.

### Triangle count (`algo.triangle_count`)

Triangle count measures closed triples in a simple-undirected projection.

```sql
SELECT vertex_id,
       triangle_count,
       degree,
       local_clustering_coefficient,
       global_triangle_count
FROM system.algo.triangle_count('social', vertex_label := 'Person')
ORDER BY triangle_count DESC, vertex_id;
```

Before counting, DuckGQL ignores self-loops, treats edge direction as
irrelevant, and coalesces reciprocal and parallel edges. Therefore repeated
relationships do not multiply triangles.

| Column | Meaning |
| --- | --- |
| `triangle_count` | Number of distinct triangles containing this vertex. |
| `degree` | Degree in the simple-undirected projection. |
| `local_clustering_coefficient` | `2 * triangle_count / (degree * (degree - 1))`, or 0 below degree 2. |
| `global_triangle_count` | Number of distinct graph-wide triangles, repeated on every row. |

The implementation orients edges by degree and intersects forward
neighborhoods. It avoids naive cubic enumeration, but cost still depends on
degree distribution and can rise on very dense or highly skewed graphs.

### Local clustering coefficient (`algo.lcc`)

`algo.lcc` implements the direction-preserving LDBC Graphalytics definition,
which differs deliberately from the simple-undirected coefficient returned by
`algo.triangle_count`.

```sql
CALL algo.lcc('social', edge_label := 'FOLLOWS')
YIELD vertex_id, degree, directed_neighbor_edge_count, local_clustering_coefficient
RETURN vertex_id, degree, directed_neighbor_edge_count, local_clustering_coefficient
ORDER BY local_clustering_coefficient DESC, vertex_id;
```

For each vertex `v`, `N(v)` is the unique union of its incoming and outgoing
neighbors. `degree` is `|N(v)|`. DuckGQL then counts directed edges between
members of `N(v)` and reports:

```text
directed_neighbor_edge_count / (degree * (degree - 1))
```

The coefficient is 0 below degree 2. Self-loops are ignored and duplicate
directed edges are coalesced. Reciprocal edges contribute in both directions.
On symmetric input this reduces to the conventional undirected local
clustering coefficient.

Use `triangle_count` when the graph should be interpreted as simple and
undirected. Use `lcc` when relationship direction inside a vertex's
neighborhood is semantically important.

## Yield graph properties with algorithm results

The GQL pipeline can fetch registered vertex properties alongside algorithm
outputs. If `social` exposes a `name` vertex property:

```sql
CALL algo.degree('social')
YIELD name, out_degree, in_degree, total_degree
RETURN name, out_degree, in_degree, total_degree
ORDER BY total_degree DESC, name
LIMIT 10;
```

Traversal algorithms can also yield edge properties because they return the
discovering `edge_id`. The source row has no parent or discovering edge, so
those properties are nullable there.

Only names listed by `YIELD` remain available to `RETURN`. Variables from a
preceding `MATCH` do not cross the blocking procedure boundary unless their
needed values are yielded by the algorithm result.

## CSR construction and reuse

Algorithms request the smallest CSR capability set they need. For example:

- BFS requests the chosen topology direction and edge IDs for its parent tree.
- SCC requests both outgoing and incoming topology.
- An edge-label filter adds edge-label data.
- A vertex-label filter adds vertex-label data.
- Multi-threaded PageRank requests incoming topology plus compact outgoing
  degrees; single-threaded PageRank uses outgoing topology.

If the database instance already holds a compatible snapshot, the algorithm
reuses it. Otherwise DuckGQL builds and publishes a compatible projection. A
later algorithm may need a wider capability set and replace a narrower cached
snapshot. Connections using the same open DuckDB database instance can reuse
the immutable published snapshot.

Snapshots live only in memory and are not persisted in the `.duckdb` file.
After reopening the database, the first CSR consumer builds one again.

### Build the full snapshot explicitly

Normal algorithm calls do not require a preceding build. Use the explicit full
build when adjacency inspection, optimizer statistics, or workload preparation
needs every CSR capability immediately:

```sql
CALL gql_build_csr('social');
```

The result reports graph version, vertex and edge counts, resident memory, and
the build count. Full construction may consume substantially more memory than
an algorithm-specific projection, so it should not be an unconditional setup
step.

CSR construction and CSR algorithms currently require autocommit mode. They
are rejected inside an explicit transaction:

```sql
-- Not currently supported:
BEGIN;
CALL algo.pagerank('social');
COMMIT;
```

`SET memory_limit` does not cap all native CSR and PageRank allocations. For
large graphs, plan from measured CSR size and process memory rather than
treating DuckDB's memory limit as a hard bound for these operations.

## Inspect adjacency and CSR state

`gql_neighbors` returns `(neighbor_id, edge_id)` for one prepared vertex and
direction:

```sql
CALL gql_neighbors('social', 42, 'out');
```

Inspect the cached snapshot:

```sql
SELECT graph_name,
       graph_version,
       vertex_count,
       edge_count,
       memory_bytes,
       build_count,
       has_outgoing,
       has_incoming,
       has_edge_ids,
       has_edge_labels,
       has_vertex_labels,
       has_out_degrees
FROM gql_csr_stats('social');
```

The complete result also breaks memory into topology, identity, label, and
auxiliary bytes; exposes compact ordinal/label representation details; and
reports snapshot acquisitions and external source-snapshot identity when
available.

Per-edge-label statistics are available after a full snapshot has prepared
them:

```sql
SELECT *
FROM gql_csr_edge_stats('social')
ORDER BY edge_label;
```

These rows include edge count, active source and destination counts, average
directional degree, and maximum directional degree. The optimizer can use them
to compare selective CSR expansion with a bulk edge-table scan.

### PageRank execution metrics

PageRank publishes the latest run's metrics for the current connection:

```sql
CALL algo.pagerank('social');

SELECT csr_built,
       csr_seconds,
       initialization_seconds,
       iteration_seconds,
       output_seconds,
       total_seconds,
       worker_count,
       vertex_count,
       edge_count,
       iterations,
       converged
FROM gql_algorithm_stats('social', 'pagerank');
```

`csr_built = false` means that run reused a compatible snapshot. Algorithm
metrics are currently instrumented for PageRank; an unknown or not-yet-run
algorithm produces no metrics row.

## Invalidation and consistency

Managed GQL mutations and direct SQL writes to managed graph tables invalidate
the affected snapshot. The next CSR consumer rebuilds the capabilities it
needs. Referenced external graphs are also checked against their available
source-snapshot identity.

DuckGQL version-checks snapshots before publication and consumption, so an
algorithm does not silently run against topology known to be stale. The base
tables remain authoritative throughout this lifecycle.

Rebuild explicitly only when a full snapshot is needed immediately:

```sql
CALL gql_build_csr('social');
```
