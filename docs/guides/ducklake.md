# Query DuckLake tables as a graph

DuckGQL can expose selected columns from existing DuckLake tables as a typed,
read-only graph. The source data stays in DuckLake, so you can add graph
queries and algorithms to an analytical workflow without maintaining a second
copy of the data.

## Attach DuckLake

Install and load DuckLake, then attach your catalog with the alias you want to
use in the graph mapping:

```sql
INSTALL ducklake;
LOAD ducklake;
LOAD duckgql;

ATTACH 'ducklake:lakehouse.ducklake' AS lake;
```

If the DuckLake catalog stores data in S3, configure its catalog, data path,
and credentials through DuckLake as usual. DuckGQL reads through the attached
`lake` alias.

## Map tables to a typed graph

Choose the source columns that identify vertices, connect edges, and become
graph properties:

```sql
CREATE GRAPH social TYPED {
    (Person :Person {id INT64 NOT NULL, name STRING, age INT64}),
    (Person)-[:KNOWS {id INT64 NOT NULL, since INT32}]->(Person)
}
FROM TABLES (
    VERTEX TABLE lake.main.person
        MAP TO NODE TYPE Person
        KEY (person_id)
        PROPERTIES (
            person_id AS id,
            full_name AS name,
            age_years AS age
        ),
    EDGE TABLE lake.main.person_knows
        MAP TO EDGE TYPE KNOWS
        KEY (relationship_id)
        SOURCE (src_person_id) REFERENCES NODE TYPE Person
        DESTINATION (dst_person_id) REFERENCES NODE TYPE Person
        PROPERTIES (
            relationship_id AS id,
            since_year AS since
        )
)
OPTIONS (
    SNAPSHOT_POLICY 'LIVE',
    ACCESS_MODE 'READ_ONLY',
    VALIDATE TRUE
);
```

Only the mapped columns are visible through GQL. Validation checks vertex and
edge keys, endpoints, and the mapped schema before registering the graph.

## Query and analyze

Select the graph and use it like any other DuckGQL graph:

```sql
SESSION SET GRAPH social;

MATCH (a:Person)-[e:KNOWS]->(b:Person)
RETURN a.name, b.name, e.since;
```

Graph algorithms read the same DuckLake-backed graph:

```sql
CALL algo.pagerank('social')
YIELD vertex_id, rank
RETURN vertex_id, rank
ORDER BY rank DESC;
```

## Choose a snapshot policy

Use `SNAPSHOT_POLICY 'LIVE'` for analysis that should follow the latest
DuckLake snapshot. Queries see newly committed data, and algorithms refresh
automatically after the snapshot changes.

For reproducible results, attach DuckLake at a specific version:

```sql
ATTACH 'ducklake:lakehouse.ducklake' AS lake (SNAPSHOT_VERSION 42);
```

Then register the graph with `SNAPSHOT_POLICY 'PINNED'` in the `OPTIONS`
clause. DuckGQL remembers snapshot 42. If `lake` is later attached at another
snapshot, the query asks you to reattach version 42 instead of silently
returning different data.

## Current scope

DuckLake-backed graphs are read-only and currently support one vertex table
and one edge table from the same DuckLake catalog, using integer keys.
`DROP GRAPH` removes the DuckGQL mapping but does not delete the DuckLake source
tables or their data.
