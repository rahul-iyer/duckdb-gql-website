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
graph properties. Repeat `VERTEX TABLE` and `EDGE TABLE` mappings to build a
heterogeneous graph from several DuckLake tables:

```sql
CREATE GRAPH social TYPED {
    (Customer :Customer {id INT64 NOT NULL, name STRING}),
    (ProductNode :ProductNode {id INT64 NOT NULL, name STRING, price FLOAT64}),
    (Customer)-[:BOUGHT {id INT64 NOT NULL, quantity INT32}]->(ProductNode)
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
        MAP TO NODE TYPE ProductNode
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
        DESTINATION (product_id) REFERENCES NODE TYPE ProductNode
        PROPERTIES (
            order_id AS id,
            quantity AS quantity
        )
)
OPTIONS (
    SNAPSHOT_POLICY 'LIVE',
    ACCESS_MODE 'READ_ONLY',
    VALIDATE TRUE
);
```

Only the mapped columns are visible through GQL. Each vertex table maps one
node type, and every edge endpoint resolves through its declared node type.
Validation checks table-local keys, endpoint references, the mapped schema,
and graph-wide uniqueness across vertex keys and across edge keys.

## Query and analyze

Select the graph and use it like any other DuckGQL graph:

```sql
SESSION SET GRAPH social;

MATCH (customer:Customer)-[order:BOUGHT]->(product:ProductNode)
RETURN customer.name, product.name, order.quantity;
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

DuckLake-backed graphs are read-only and support multiple vertex and edge
tables from the same DuckLake catalog, using integer keys. Source keys remain
the values returned by `element_id`, so they must be unique across all mapped
vertex tables or all mapped edge tables. Each node type currently maps one
vertex table; joining several physical tables into one node record is not yet
supported. `DROP GRAPH` removes the DuckGQL mapping but does not delete the
DuckLake source tables or their data.
