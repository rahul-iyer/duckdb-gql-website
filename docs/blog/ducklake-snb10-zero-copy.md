---
title: "30 Million Nodes. One DuckLake. Zero Graph Re-Import."
description: "Turn LDBC SNB SF10 tables into a typed property graph without copying the data, reserving ID ranges, or running a second database."
head:
  - - meta
    - property: og:type
      content: article
  - - meta
    - property: og:title
      content: "30 Million Nodes. One DuckLake. Zero Graph Re-Import."
  - - meta
    - property: og:description
      content: "A runnable DuckLake + DuckGQL tutorial for querying LDBC SNB SF10 without a graph re-import or manual ID ranges."
  - - meta
    - name: twitter:card
      content: summary
  - - meta
    - name: twitter:title
      content: "30 Million Nodes. One DuckLake. Zero Graph Re-Import."
  - - meta
    - name: twitter:description
      content: "Map LDBC SNB SF10 into a live typed graph—without a second copy, global ID ranges, or an identity service."
---

<div class="benchmark-hero">
  <div class="benchmark-eyebrow">DuckLake + DuckGQL · August 2026</div>
  <h1>30 million nodes.<br>One DuckLake.<br>Zero graph re-import.</h1>
  <p>Keep LDBC SNB SF10 in an open lakehouse. Query it as a typed property graph—without copying rows, reserving ID ranges, or operating an identity service.</p>
</div>

<div class="benchmark-stat-grid">
  <div class="benchmark-stat"><strong>29.4M</strong><span>Person and Message nodes in this walkthrough</span></div>
  <div class="benchmark-stat"><strong>55.0M</strong><span>KNOWS, HAS_CREATOR, and REPLY_OF relationships</span></div>
  <div class="benchmark-stat"><strong>1</strong><span>authoritative DuckLake snapshot</span></div>
  <div class="benchmark-stat"><strong>0</strong><span>rows copied into DuckGQL</span></div>
</div>

The usual way to run graph analytics on lakehouse data starts with a tax: export
the tables, reshape them, import them into a graph database, and then invent a
sync process for the second copy.

LDBC's Social Network Benchmark makes that tax visible. The Interactive v1
SF10 fixture used for this walkthrough contains 29,987,835 vertices and
178,561,949 directed relationship rows. Dataset releases differ, so the counts
below describe this fixture rather than every dataset published under the SF10
name. At this size, duplicate storage, reload time, and snapshot drift become
architecture—not housekeeping. The Graph Data Council publishes the current
[SNB datasets](https://ldbcouncil.org/benchmarks/snb/datasets/) and
[SNB documentation](https://ldbcouncil.org/ldbc_snb_docs/).

There is a simpler path:

```text
SNB relational tables
    -> one-time projection into DuckLake
    -> typed DuckGQL mapping (metadata only)
    -> MATCH and graph algorithms
```

DuckLake remains the source of truth. DuckGQL stores the graph schema and column
mapping, then reads the attached DuckLake tables directly. There is no
`COPY GRAPH`, no second authoritative graph store, and no graph reload when a
new DuckLake snapshot commits. You keep the IDs already present in SNB;
DuckGQL manages the dense internal IDs needed by graph execution.

This walkthrough builds a useful SF10 slice with two node types and three edge
types. It contains 29,366,816 nodes and 55,043,678 directed relationships in
the dataset used for this article. The same mapping pattern extends to forums,
places, organisations, tags, likes, and the rest of SNB.

## What "zero-copy" actually means

It does **not** mean data materializes from thin air. If your SNB data currently
lives in CSV, Parquet, or a DuckDB database, loading and shaping it into
DuckLake is a real, one-time data preparation step.

Zero-copy begins at the graph boundary:

- DuckGQL does not copy the mapped DuckLake rows into `gql_data`;
- DuckLake tables remain authoritative;
- `MATCH` reads the source mappings;
- algorithms derive only the in-memory topology they need; and
- dropping the graph removes the mapping, not the lakehouse tables.

That distinction matters. This is not a benchmark trick that hides ingestion.
It is an ownership model: one durable copy of the data, with graph structure
declared over it.

## 1. Start with the SNB relational tables

This tutorial assumes a normalized SF10 DuckDB database named
`snb10-relational.duckdb` with the standard `person`, `message`, and `knows`
tables. You can produce that source from the
[LDBC SNB data generator and specification](https://ldbcouncil.org/ldbc_snb_docs/ldbc-snb-specification.pdf),
or adapt the column names below to your existing SNB Parquet or CSV files.

The source columns used here are:

| Table | Columns used |
| --- | --- |
| `person` | `p_personid`, names, creation timestamp |
| `message` | `m_messageid`, creator, reply target, forum, content, timestamp, length |
| `knows` | person endpoints and creation timestamp |

Open a persistent DuckDB database for the graph catalog, load both extensions,
and attach the source plus a new DuckLake catalog:

```sql
INSTALL ducklake;
LOAD ducklake;

INSTALL duckgql FROM community;
LOAD duckgql;

ATTACH 'snb10-relational.duckdb' AS raw (READ_ONLY);

ATTACH 'ducklake:snb10.ducklake' AS lake (
    DATA_PATH 'snb10-data'
);
```

DuckLake's metadata is stored in `snb10.ducklake`; table data goes under
`snb10-data`. Production deployments can point the catalog and data path at
their normal database and object-storage configuration. The
[DuckLake connection guide](https://ducklake.select/docs/stable/duckdb/usage/connecting)
covers those options.

## 2. Bring source keys. Let DuckGQL own graph IDs.

Here is the subtle part most first attempts miss.

SNB IDs are unique inside an entity type, but different types can contain the
same numeric value. That is fine. DuckGQL qualifies a source key by its physical
node mapping, so these two rows never collide:

```text
lake.main.person_nodes  (person_key  = 42) -> (Person, 42)
lake.main.message_nodes (message_key = 42) -> (Message, 42)
```

As it reads a snapshot, DuckGQL assigns positive, dense IDs with `row_number()`
and deterministic offsets over the mapped tables. Edge endpoints are translated
through the declared source and destination node mappings, not by comparing one
global bag of source numbers. The generated IDs power joins, paths,
`element_id()`, and CSR; the original SNB ID remains the stable, user-facing
`id` property.

That means no magic ranges, identity dictionary, sequence, or atomic counter
is required in DuckLake.

| Identity | Who owns it? | Scope | Persist it externally? |
| --- | --- | --- | --- |
| `person_key`, `message_key` | Source data | One vertex mapping | Yes |
| Vertex `element_id()` | DuckGQL | Current graph snapshot | No |
| Edge source/destination keys | Source data | Declared endpoint mapping | Yes |
| Edge `element_id()` | DuckGQL | Current graph snapshot | No |

This separation is the important design choice: source keys answer **which
business row is this?** Generated IDs answer **how should this snapshot execute
as a graph?**

Create the two vertex projections in DuckLake:

```sql
CREATE TABLE lake.main.person_nodes AS
SELECT
    p_personid AS person_key,
    p_personid AS id,
    p_firstname AS first_name,
    p_lastname AS last_name,
    p_creationdate AS creation_date
FROM raw.main.person;

CREATE TABLE lake.main.message_nodes AS
SELECT
    m_messageid AS message_key,
    m_messageid AS id,
    CASE
        WHEN m_ps_forumid IS NULL THEN 'Comment'
        ELSE 'Post'
    END AS kind,
    m_creationdate AS creation_date,
    m_content AS content,
    m_ps_imagefile AS image_file,
    m_length AS length
FROM raw.main.message;
```

The edge projections keep their natural endpoint values. They do not need
relationship ID columns because DuckGQL generates snapshot-local edge IDs:

```sql
CREATE TABLE lake.main.knows_edges AS
SELECT
    k_person1id AS source_person_key,
    k_person2id AS target_person_key,
    k_creationdate AS creation_date
FROM raw.main.knows;

CREATE TABLE lake.main.has_creator_edges AS
SELECT
    m_messageid AS source_message_key,
    m_creatorid AS target_person_key
FROM raw.main.message;

CREATE TABLE lake.main.reply_of_edges AS
SELECT
    m_messageid AS source_message_key,
    m_c_replyof AS target_message_key
FROM raw.main.message
WHERE m_c_replyof IS NOT NULL;
```

The generated IDs remain deterministic for an unchanged mapping and snapshot.
With `SNAPSHOT_POLICY 'LIVE'`, a later snapshot may renumber them. Persist the
SNB `id` properties—not values returned by `element_id()`—outside the statement
that produced them.

The `kind` property keeps Post versus Comment visible while both live in one
physical `message_nodes` mapping. If you need `Post` and `Comment` as static
node labels, create separate DuckLake tables and map each to its own node type.

## 3. Map the DuckLake tables into a typed graph

The `TYPED` block is the public graph contract. `FROM TABLES` connects that
contract to physical DuckLake columns.

Vertex `KEY` is required because it identifies source rows and resolves edge
endpoints. Edge `KEY` is optional: omit it when the relationship table has no
natural identifier, as all three mappings below do.

```sql
CREATE GRAPH snb10 TYPED {
    (Person :Person {
        id INT64 NOT NULL,
        firstName STRING,
        lastName STRING,
        creationDate TIMESTAMP
    }),
    (Message :Message {
        id INT64 NOT NULL,
        kind STRING NOT NULL,
        creationDate TIMESTAMP,
        content STRING,
        imageFile STRING,
        length INT32
    }),
    (Person)-[:KNOWS {
        creationDate TIMESTAMP
    }]->(Person),
    (Message)-[:HAS_CREATOR]->(Person),
    (Message)-[:REPLY_OF]->(Message)
}
FROM TABLES (
    VERTEX TABLE lake.main.person_nodes
        MAP TO NODE TYPE Person
        KEY (person_key)
        PROPERTIES (
            id AS id,
            first_name AS firstName,
            last_name AS lastName,
            creation_date AS creationDate
        ),
    VERTEX TABLE lake.main.message_nodes
        MAP TO NODE TYPE Message
        KEY (message_key)
        PROPERTIES (
            id AS id,
            kind AS kind,
            creation_date AS creationDate,
            content AS content,
            image_file AS imageFile,
            length AS length
        ),
    EDGE TABLE lake.main.knows_edges
        MAP TO EDGE TYPE KNOWS
        SOURCE (source_person_key) REFERENCES NODE TYPE Person
        DESTINATION (target_person_key) REFERENCES NODE TYPE Person
        PROPERTIES (creation_date AS creationDate),
    EDGE TABLE lake.main.has_creator_edges
        MAP TO EDGE TYPE HAS_CREATOR
        SOURCE (source_message_key) REFERENCES NODE TYPE Message
        DESTINATION (target_person_key) REFERENCES NODE TYPE Person,
    EDGE TABLE lake.main.reply_of_edges
        MAP TO EDGE TYPE REPLY_OF
        SOURCE (source_message_key) REFERENCES NODE TYPE Message
        DESTINATION (target_message_key) REFERENCES NODE TYPE Message
)
OPTIONS (
    SNAPSHOT_POLICY 'LIVE',
    ACCESS_MODE 'READ_ONLY',
    VALIDATE TRUE
);
```

`VALIDATE TRUE` scans the mapping before publishing it. It checks vertex-key
uniqueness within each node mapping, supplied edge-key uniqueness within each
edge mapping, non-null requirements, endpoint integrity, and exact physical
types. Reusing `42` in `Person` and `Message`—or reusing an edge key in two
different edge mappings—is valid. On tens of millions of rows validation is
real work, but it turns identity bugs into registration errors instead of
corrupt traversals.

If an edge table does have a useful source identifier, supply it after the edge
type. DuckGQL validates it within that mapping, while still returning a managed
snapshot-local value from `element_id(relationship)`:

```sql
EDGE TABLE lake.main.likes_edges
    MAP TO EDGE TYPE LIKES
    KEY (like_id)
    SOURCE (source_person_key) REFERENCES NODE TYPE Person
    DESTINATION (target_message_key) REFERENCES NODE TYPE Message
```

After a successful validation, select the graph:

```sql
SESSION SET GRAPH snb10;
```

No SNB row has been copied into DuckGQL. What now exists is a typed,
read-only graph view over the DuckLake tables.

## 4. Ask graph questions directly

Find a person's outgoing KNOWS relationships:

```sql
MATCH (person:Person)-[knows:KNOWS]->(friend:Person)
WHERE person.id = 15393162801011
RETURN friend.id,
       friend.firstName,
       friend.lastName,
       knows.creationDate
ORDER BY knows.creationDate DESC, friend.id ASC;
```

Find the 20 newest messages created by that person's friends—a compact version
of the shape behind SNB Interactive Complex Query 2:

```sql
MATCH (source:Person)-[:KNOWS]->(friend:Person),
      (message:Message)-[:HAS_CREATOR]->(friend)
WHERE source.id = 15393162801011
RETURN friend.id,
       friend.firstName,
       friend.lastName,
       message.id,
       message.kind,
       message.creationDate,
       COALESCE(message.content, message.imageFile, '') AS body
ORDER BY message.creationDate DESC, message.id ASC
LIMIT 20;
```

Find recent replies to messages by one person—the core graph shape of SNB
Interactive Complex Query 8:

```sql
MATCH (source:Person)
WHERE source.id = 15393162801011
MATCH (parent:Message)-[:HAS_CREATOR]->(source)
MATCH (reply:Message)-[:REPLY_OF]->(parent)
MATCH (reply)-[:HAS_CREATOR]->(author:Person)
RETURN author.id,
       author.firstName,
       author.lastName,
       reply.creationDate,
       reply.id,
       reply.content
ORDER BY reply.creationDate DESC, reply.id ASC
LIMIT 20;
```

The graph is deliberately read-only. Write through DuckLake's normal SQL or
ingestion path; let the graph mapping remain an analytical contract over the
committed data.

## 5. Run algorithms without a separate graph load

Shortest path over the social network uses the SNB-facing IDs to locate the
people, then passes their canonical element IDs into the algorithm:

```sql
MATCH (source:Person), (target:Person)
WHERE source.id = 32985348886934
  AND target.id = 15393162823425
CALL algo.shortest_path_length(
    'snb10',
    element_id(source),
    element_id(target),
    'Person',
    'KNOWS'
)
YIELD distance
RETURN distance;
```

PageRank can project just `Person` vertices and `KNOWS` relationships. Its
output uses DuckGQL's snapshot-local vertex ID, so retain the mapped `Person.id`
property when you need a durable external identifier:

```sql
SELECT vertex_id, rank
FROM system.algo.pagerank(
    'snb10',
    vertex_label := 'Person',
    edge_label := 'KNOWS',
    damping := 0.85,
    tolerance := 1e-8
)
ORDER BY rank DESC
LIMIT 20;
```

You do not need to call an explicit build first. Each algorithm asks DuckGQL
for the smallest compatible in-memory CSR projection and builds it on demand.
That CSR is disposable derived state; it is not another durable copy of SNB.

If you want to prepare a full CSR for adjacency inspection or predictable
cold-start timing, do it explicitly:

```sql
CALL gql_build_csr('snb10');

SELECT source_catalog, source_snapshot_id, vertex_count, edge_count
FROM gql_csr_stats('snb10');
```

Measure the cold build separately from warm algorithm execution. The first
algorithm call can include topology preparation; later calls may reuse the
compatible projection.

## 6. What the referenced mapping costs

Zero-copy removes a second durable graph import. It does not make source-table
translation free.

We compared this DuckLake path with a managed `COPY GRAPH` database on the same
SF10 `Person`/`KNOWS` projection: 65,645 vertices and 3,877,032 directed edges.
Both modes returned the same counts and the same PageRank result—65,645 rows,
rank sum `1.0`, 27 iterations, converged.

The local engineering run used an Apple M5 Pro MacBook Pro with 24 GB of RAM,
DuckDB limited to 8 GB, four threads, and the release build from DuckGQL commit
`e03d329`. Direct-query and PageRank medians use three warmups followed by ten
measured runs; cold CSR uses five fresh processes because CSR is
connection-local.

| Phase | Managed | DuckLake referenced | DuckLake / managed |
| --- | ---: | ---: | ---: |
| Direct `MATCH` edge count | 11.370 ms | 66.063 ms | 5.81× |
| Cold full CSR construction | 134.228 ms | 391.499 ms | 2.92× |
| Warm PageRank | 146.944 ms | 144.488 ms | 0.98× |

The direct referenced plan currently does more work to assign canonical IDs
and translate both endpoints through the declared node mapping. CSR construction
pays the same translation cost. Once both modes have an equivalent in-memory
CSR, warm PageRank is effectively tied—the 1.7% difference is not meaningful
for this run.

Fresh graph registration took 82 ms for the validated DuckLake mapping, while
managed `COPY GRAPH` took 1.236 seconds after a separate 79 ms Parquet export.
Those operations are not semantically identical: DuckLake registration retains
the source tables as the authority; managed import creates another durable
graph representation.

These are local medians, not an official LDBC result. OS file caches were not
dropped, the measured graph contains only `Person` and `KNOWS`, and the query
mix is intentionally small. Treat the numbers as the current cost model, not a
general database leaderboard.

## 7. Let snapshots solve the synchronization problem

The graph above uses `SNAPSHOT_POLICY 'LIVE'`. Every statement sees the current
committed DuckLake snapshot. When that snapshot changes, DuckGQL invalidates a
stale derived CSR and the next algorithm rebuilds against the new snapshot.

This replaces a fragile question—"did we reload the graph database?"—with a
precise one: "which DuckLake snapshot backs this result?"

The identity contract follows the same boundary:

| Value | Unchanged snapshot | New `LIVE` snapshot |
| --- | --- | --- |
| Mapped SNB `id` property | Stable | Stable for the same source row |
| Generated `element_id()` | Stable | May be renumbered |
| MATCH/path/algorithm result | Internally consistent | Recomputed from the new snapshot |
| Externally cached `element_id()` | Usable only with that snapshot | Do not reuse |

There is no distributed counter to synchronize and no ID allocation table to
update. A query observes one committed snapshot, and DuckGQL derives the graph
identity needed for that snapshot.

For a reproducible experiment, attach a historical snapshot and create a pinned
mapping:

```sql
ATTACH 'ducklake:snb10.ducklake' AS lake (
    DATA_PATH 'snb10-data',
    SNAPSHOT_VERSION 42
);
```

Then use:

```sql
OPTIONS (
    SNAPSHOT_POLICY 'PINNED',
    ACCESS_MODE 'READ_ONLY',
    VALIDATE TRUE
)
```

DuckGQL records snapshot 42. If `lake` is later attached at a different
snapshot, the pinned graph fails rather than silently returning different data.
DuckLake documents its snapshot model and time travel in the
[snapshot guide](https://ducklake.select/docs/stable/duckdb/usage/snapshots)
and [time-travel guide](https://ducklake.select/docs/stable/duckdb/usage/time_travel).

## Scaling from the slice to full SNB SF10

The complete SNB graph adds node mappings for `Forum`, `Place`, `Organisation`,
`Tag`, and `TagClass`, plus edge mappings such as `LIKES`, `HAS_TAG`,
`HAS_MEMBER`, `IS_LOCATED_IN`, and `IS_PART_OF`.

The rules do not change:

1. Build one DuckLake table per static node type.
2. Use each entity type's natural integer source key.
3. Build one DuckLake table per static edge type.
4. Omit edge `KEY` when the source has no relationship identifier.
5. Make endpoint column types exactly match their vertex key types.
6. Declare every graph-visible property in `TYPED` and map it exactly once.
7. Register with `VALIDATE TRUE` before trusting the topology.

One physical table currently maps to one static node type. DuckGQL can union
many vertex and edge tables into one heterogeneous graph, but it does not join
several physical tables together to construct a single vertex. If your source
shape needs a join, create the desired DuckLake view or materialized projection
first.

## Performance claims we are not making

This article is a runnable architecture walkthrough, not an official LDBC
benchmark result. The
[SNB Interactive workload](https://ldbcouncil.org/docs/papers/ldbc-snb-interactive-v2-tpctc2023-preprint.pdf)
has a defined driver, update stream, validation process, and reporting rules.
The query examples above demonstrate equivalent graph shapes; they do not
constitute an audited score.

The comparison above measures the exact local DuckLake catalog and managed
graph described there. It does not predict remote object-store performance or
the complete SNB Interactive workload. Measure the catalog, snapshot, hardware,
and query mix you intend to run.

What the design establishes is simpler and more durable: **you can keep SF10 in
DuckLake and make it a live typed graph without importing those rows into a
second graph store.**

## The takeaway

Lakehouse versus graph is a false choice when graph structure can be a typed
view over the lakehouse tables.

DuckLake gives SNB one authoritative, versioned home. DuckGQL adds patterns,
paths, and algorithms at query time. The expensive integration problem is no
longer "how do I keep two databases synchronized?" It becomes "which graph
schema should I declare over this snapshot?"

That is a much better problem.

Read the complete [DuckLake mapping guide](../guides/ducklake.md), explore the
[query guide](../guides/querying.md), or try DuckGQL in the
[browser playground](https://duckgql.com/).
