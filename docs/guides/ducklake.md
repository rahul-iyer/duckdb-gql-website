# Query DuckLake tables as a graph

DuckGQL can expose selected columns from existing DuckLake tables as one typed,
read-only property graph. Queries scan the source tables through the attached
catalog; the graph mapping does not copy rows into `gql_data` or become a
second authoritative store.

This model is useful when relational ingestion, partitioning, snapshotting, and
retention already live in DuckLake but graph patterns or algorithms are needed
for analysis.

## Architecture at a glance

```text
DuckLake tables
    -> explicit typed graph mapping
    -> logical vertex and edge relations
    -> MATCH / OPTIONAL MATCH / aggregation
    -> optional derived CSR for algorithms and selective topology access
```

The source tables remain authoritative. DuckGQL persists only graph schema,
column mappings, source identity, and snapshot policy. CSR is an in-memory,
rebuildable snapshot tied to the DuckLake snapshot ID.

The same `FROM TABLES` architecture can reference tables in an attached DuckDB
catalog. DuckLake additionally supplies persistent table identities and
snapshot IDs, which enable `LIVE` invalidation and `PINNED` reproducibility.

## Attach DuckLake

Install and load DuckLake, load DuckGQL, and attach the lake under a stable
catalog alias:

```sql
INSTALL ducklake;
LOAD ducklake;
LOAD duckgql;

ATTACH 'ducklake:lakehouse.ducklake' AS lake;
```

Use DuckLake's normal catalog, data-path, secret, and object-storage
configuration. DuckGQL reads through the attached `lake` alias and does not
manage those credentials.

The alias is part of the persistent graph mapping. Attach the same source under
that alias after reopening the DuckDB database.

## Declare the logical graph schema

The `TYPED` block defines graph-visible node and edge types independently from
physical table names:

```sql
CREATE GRAPH commerce TYPED {
    (Customer :Customer {
        id INT64 NOT NULL,
        name STRING
    }),
    (Product :Product {
        id INT64 NOT NULL,
        name STRING,
        price FLOAT64
    }),
    (Customer)-[:BOUGHT {
        id INT64 NOT NULL,
        quantity INT32,
        purchased_at ZONEDDATETIME
    }]->(Product)
}
FROM TABLES (
    -- Physical mappings go here.
);
```

The aliases `Customer` and `Product` are schema identities used by edge
endpoint declarations. Labels and edge types are static for each physical
mapping: rows from a table mapped to `Customer` are exposed as `Customer`
nodes, without requiring a label column in DuckLake.

## Map one vertex and edge table

Each mapping declares its source table, canonical element key, and selected
properties:

```sql
CREATE GRAPH social TYPED {
    (Person :Person {
        id INT64 NOT NULL,
        name STRING,
        age INT64
    }),
    (Person)-[:KNOWS {
        id INT64 NOT NULL,
        since INT32
    }]->(Person)
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

Mapping clauses mean:

| Clause | Contract |
| --- | --- |
| `MAP TO NODE TYPE Person` | Every row has the static graph type and labels declared for `Person`. |
| `KEY (person_id)` | Integer source key becomes the graph element ID. |
| `source_column AS property` | Exposes exactly that source column under the declared graph property. |
| `MAP TO EDGE TYPE KNOWS` | Every row has static relationship type `KNOWS`. |
| `SOURCE (...) REFERENCES NODE TYPE ...` | Source endpoint column resolves against that mapped node type's key. |
| `DESTINATION (...) REFERENCES NODE TYPE ...` | Destination endpoint column resolves against that mapped node type's key. |

Every property declared on a mapped graph type must be mapped exactly once by
its physical table. Source and graph names may differ, but the DuckDB source
type must exactly match the native type expected by the GQL declaration.

Only mapped properties are visible:

```sql
SESSION SET GRAPH social;

MATCH (person:Person)
RETURN person.id, person.name, person.age;
```

If `person` also has a `private_note` source column that is not listed, then
`person.private_note` is a binding error. This is deliberate projection and
not a row-level security mechanism; users with direct DuckLake access can still
query the source column.

## Map several vertex and edge tables

Repeat `VERTEX TABLE` and `EDGE TABLE` entries to form a heterogeneous graph:

```sql
CREATE GRAPH commerce TYPED {
    (Customer :Customer {
        id INT64 NOT NULL,
        name STRING
    }),
    (Product :Product {
        id INT64 NOT NULL,
        name STRING,
        price FLOAT64
    }),
    (Customer)-[:BOUGHT {
        id INT64 NOT NULL,
        quantity INT32
    }]->(Product),
    (Customer)-[:VIEWED {
        id INT64 NOT NULL,
        viewed_at ZONEDDATETIME
    }]->(Product)
}
FROM TABLES (
    VERTEX TABLE lake.main.customers
        MAP TO NODE TYPE Customer
        KEY (customer_id)
        PROPERTIES (
            customer_id AS id,
            customer_name AS name
        ),
    VERTEX TABLE lake.main.products
        MAP TO NODE TYPE Product
        KEY (product_id)
        PROPERTIES (
            product_id AS id,
            product_name AS name,
            price AS price
        ),
    EDGE TABLE lake.main.orders
        MAP TO EDGE TYPE BOUGHT
        KEY (order_id)
        SOURCE (customer_id) REFERENCES NODE TYPE Customer
        DESTINATION (product_id) REFERENCES NODE TYPE Product
        PROPERTIES (
            order_id AS id,
            quantity AS quantity
        ),
    EDGE TABLE lake.main.product_views
        MAP TO EDGE TYPE VIEWED
        KEY (view_id)
        SOURCE (customer_id) REFERENCES NODE TYPE Customer
        DESTINATION (product_id) REFERENCES NODE TYPE Product
        PROPERTIES (
            view_id AS id,
            viewed_at AS viewed_at
        )
)
OPTIONS (
    SNAPSHOT_POLICY 'LIVE',
    ACCESS_MODE 'READ_ONLY',
    VALIDATE TRUE
);
```

DuckGQL combines the physical mappings into logical vertex and edge relations.
Unlabeled `MATCH (node)` can see rows from every mapped vertex table, while a
typed pattern selects the corresponding branch:

```sql
SESSION SET GRAPH commerce;

MATCH (customer:Customer)-[purchase:BOUGHT]->(product:Product)
RETURN customer.name, product.name, purchase.quantity;
```

Current mapping rules are:

- at least one vertex table and one edge table are required;
- all mapped tables must come from the same attached catalog;
- each declared node type maps to one physical vertex table;
- several node types, edge types, and edge tables can participate in one graph;
- an edge's endpoint declarations identify the vertex mappings used to resolve
  its source and destination columns;
- graph element keys use integer DuckDB types;
- an endpoint column's physical type must exactly match the referenced vertex
  key type.

This is heterogeneous union, not a relational join that assembles one node from
several physical tables. Joining several source tables into one node record is
not currently supported; create a DuckLake view or materialized table with the
desired row shape before mapping it.

## Element identity and uniqueness

Referenced keys are graph identities, not merely exposed properties:

```sql
MATCH (customer:Customer)
RETURN element_id(customer), customer.id;
```

For referenced graphs, `element_id(customer)` is the integer source key. All
mapped vertex tables therefore share one graph-wide vertex ID namespace. All
mapped edge tables similarly share one graph-wide edge ID namespace.

With validation enabled, this is rejected even if the colliding IDs belong to
different node types:

```text
customers.customer_id = 101
products.product_id   = 101
```

Vertex and edge namespaces are separate, so a vertex ID may equal an edge ID.
Uniqueness across physical tables is essential because algorithms, CSR, path
state, and returned element IDs operate on the logical union.

## Registration validation

`VALIDATE TRUE` checks the complete mapping before it is published:

- each physical key is non-null and unique within its table;
- vertex keys are unique across every mapped vertex table;
- edge keys are unique across every mapped edge table;
- edge source and destination values are non-null and resolve through the
  declared node-type mapping;
- endpoint and key physical types match exactly;
- every declared property is mapped exactly once;
- mapped property types match the typed graph schema;
- source values satisfy graph `NOT NULL` declarations.

If any check fails, graph creation rolls back without leaving a partial
mapping.

`VALIDATE FALSE` skips data scans for key uniqueness, endpoint integrity, and
non-null property values. It still validates mapping structure, column
existence, physical types, graph types, and catalog rules. Use it only when the
lake's ingestion contract already guarantees the skipped invariants.

## Query the mapped graph

After selection, referenced graphs use the same query surface as managed
graphs:

```sql
SESSION SET GRAPH commerce;

MATCH (customer:Customer)-[purchase:BOUGHT]->(product:Product)
WHERE purchase.quantity >= 2
RETURN customer.name,
       product.name,
       product.price,
       purchase.quantity
ORDER BY product.price DESC;
```

Fixed and supported variable-length patterns, optional matching, aggregation,
sorting, and paging read through the source mappings. The heterogeneous logical
relations use `UNION ALL` over the mapped physical tables and project a common
typed graph shape.

DuckGQL property indexes are not available for referenced graphs. Source-side
partition pruning, statistics, and DuckLake optimizations still apply beneath
the mapped query.

## Run graph algorithms

Algorithms build the minimal compatible CSR they need directly from the
referenced graph:

```sql
CALL algo.pagerank('commerce')
YIELD vertex_id, rank
RETURN vertex_id, rank
ORDER BY rank DESC;
```

No explicit build is required. To prepare a full snapshot for adjacency APIs,
optimizer statistics, or predictable cold-start timing:

```sql
CALL gql_build_csr('commerce');
```

CSR and algorithm operations are autocommit-only. The CSR is derived memory,
not data written back into DuckLake.

For a `LIVE` DuckLake graph, the current DuckLake snapshot ID becomes part of
CSR validity. When the source snapshot changes, stale CSR is evicted and the
next algorithm rebuilds against the new committed snapshot.

```sql
SELECT source_catalog, source_snapshot_id
FROM gql_csr_stats('commerce');
```

This reports which DuckLake snapshot backs the prepared CSR.

## Choose `LIVE` snapshot policy

Use `LIVE` for analysis that should follow the attached catalog's latest
committed snapshot:

```sql
OPTIONS (
    SNAPSHOT_POLICY 'LIVE',
    ACCESS_MODE 'READ_ONLY',
    VALIDATE TRUE
)
```

Each query reads the snapshot visible through the attached DuckLake catalog.
Newly committed rows can appear without recreating the graph mapping. CSR
consumers compare the observed snapshot ID and rebuild derived topology when it
changes.

`LIVE` gives freshness, not cross-query repeatability. Two statements can see
different committed snapshots when a writer commits between them.

## Choose `PINNED` snapshot policy

Use `PINNED` when the same graph definition must reproduce results against one
DuckLake snapshot.

First attach the desired snapshot:

```sql
ATTACH 'ducklake:lakehouse.ducklake' AS lake (
    SNAPSHOT_VERSION 42
);
```

Then create the graph with:

```sql
OPTIONS (
    SNAPSHOT_POLICY 'PINNED',
    ACCESS_MODE 'READ_ONLY',
    VALIDATE TRUE
)
```

DuckGQL records snapshot 42 in graph metadata. Every later query and algorithm
checks `lake.current_snapshot()`. If `lake` is attached at snapshot 43, DuckGQL
fails with a request to attach snapshot 42 rather than silently falling
forward.

`PINNED` is available only for DuckLake sources attached with a snapshot. An
ordinary attached DuckDB catalog does not expose DuckLake snapshot identity and
therefore supports only live referenced access.

## Schema and table identity checks

DuckGQL records a fingerprint of graph-visible source structure:

- persistent DuckLake table identity;
- qualified mapped table names;
- key and endpoint column names, types, and nullability;
- static node and edge types;
- mapped property columns, types, and graph nullability.

Queries validate this fingerprint. Dropping and recreating a compatible-looking
table under the same name does not silently inherit the old mapping because its
persistent table identity changed. Removing or changing a mapped column also
requires graph recreation.

Unmapped private columns are excluded from the fingerprint. Adding or changing
an unmapped source column does not invalidate an otherwise compatible graph
mapping.

DuckLake table names used by referenced mappings currently need to be unique
within the catalog because persistent table identity lookup is not yet
schema-disambiguated when duplicate names exist.

## Read-only boundary

The only supported access mode is explicit read-only:

```sql
ACCESS_MODE 'READ_ONLY'
```

DuckGQL rejects graph `INSERT`, `SET`, `REMOVE`, and `DELETE` against referenced
storage. It also rejects `gql_create_property_index`, because that would create
a physical index in storage DuckGQL does not own.

Write through DuckLake's normal ingestion or SQL path. A `LIVE` graph sees the
new committed snapshot on later queries. A `PINNED` graph continues to require
its recorded snapshot.

## Drop the mapping safely

```sql
DROP GRAPH commerce;
```

Dropping a referenced graph removes DuckGQL schema, table mappings, source
metadata, and derived state. It never drops or mutates the mapped DuckLake
tables.

`DROP GRAPH` is autocommit-only. Use `IF EXISTS` for idempotent cleanup:

```sql
DROP GRAPH IF EXISTS commerce;
```

## Operational checklist

Before registering a production mapping:

1. Attach the intended DuckLake catalog under its durable alias.
2. Decide whether freshness (`LIVE`) or reproducibility (`PINNED`) is required.
3. Ensure all mapped tables belong to that one catalog.
4. Choose integer keys that are globally unique across vertex mappings and
   separately across edge mappings.
5. Confirm endpoint physical types exactly match their referenced key types.
6. Map every declared graph property exactly once with an exact native type.
7. Run `VALIDATE TRUE` at least once on representative production data.
8. Test both `MATCH` and the algorithms the workload will use.
9. Measure CSR memory and cold-build time separately from warm query time.
10. Reattach pinned snapshots explicitly after restart.

This keeps the graph layer a typed analytical view over DuckLake rather than a
second ingestion or consistency system.
