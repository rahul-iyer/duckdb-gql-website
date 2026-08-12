# Graph lifecycle, import, and mutation

DuckGQL stores graph catalog metadata in DuckDB. Managed graphs additionally
own typed vertex and edge tables; referenced graphs point at external tables
without copying them. In both cases, the tables are authoritative and CSR is a
rebuildable derived representation.

This guide covers managed graph creation, graph-header import, typed insertion,
mutation, persistence, and removal. For zero-copy DuckLake mappings, see
[Query DuckLake tables as a graph](./ducklake.md).

## Inspect the graph catalog

```sql
SELECT graph_name,
       graph_version,
       vertex_count,
       edge_count,
       created_at
FROM gql_graphs()
ORDER BY graph_name;
```

`graph_version` changes when DuckGQL publishes graph mutations or lifecycle
changes. Vertex and edge counts describe the registered authoritative storage.

## Choose a creation model

DuckGQL has two managed creation paths:

| Model | Best for | How storage is created |
| --- | --- | --- |
| `CREATE GRAPH ... ANY` | Existing graph-header CSV or Parquet data | `COPY GRAPH` infers typed property columns and performs one full load. |
| `CREATE GRAPH ... TYPED` | New graphs with an explicit contract | Empty managed tables are materialized immediately from the declared schema. |

Both models persist. Reopening the DuckDB database restores the graph catalog
and table mappings.

## Create an import target with `ANY`

```sql
CREATE GRAPH social ANY;
```

`ANY` creates an empty catalog entry. It does not create the managed vertex and
edge tables until `COPY GRAPH` succeeds.

Creation fails when the name already exists. Use the idempotent form when
appropriate:

```sql
CREATE GRAPH IF NOT EXISTS social ANY;
```

`IF NOT EXISTS` keeps the existing graph; it does not compare or replace its
schema.

## Import graph-header files

```sql
COPY GRAPH social FROM (
    VERTICES 'nodes.parquet',
    EDGES 'relationships.parquet'
) FORMAT GRAPH;
```

The current loader accepts exactly one vertex file and one edge file. Supported
inputs are:

- `.csv`
- `.csv.gz`
- `.csv.zst`
- `.parquet`

The target graph must still be empty. `COPY GRAPH` is a full-load operation,
not append or upsert.

### Graph-header roles

Vertex input requires one `:ID` field and may contain one `:LABEL` field plus
properties:

```csv
personId:ID(People),name:string,age:int,tags:string[],:LABEL
p1,Ada,42,engineer;mathematician,Person;Researcher
p2,Grace,37,compiler,Person
```

Edge input requires one `:START_ID`, one `:END_ID`, and exactly one `:TYPE`:

```csv
:START_ID(People),:END_ID(People),:TYPE,since:int
p1,p2,KNOWS,2020
```

| Role | Contract |
| --- | --- |
| `name:ID(Group)` | Unique external vertex identity. A named ID is also retained as property `name`. |
| `:ID(Group)` | Anonymous external identity used only while resolving imported endpoints. |
| `:START_ID(Group)` | Source external ID; its group must match the vertex ID group. |
| `:END_ID(Group)` | Destination external ID; its group must match the vertex ID group. |
| `:LABEL` | Optional semicolon-delimited node label set. |
| `:TYPE` | Required scalar edge type. It must contain exactly one non-empty type. |
| `property:type` | A typed graph property. |

Relationship `:ID` headers are not currently supported by this importer;
DuckGQL generates canonical managed edge IDs. Node `:ID` values are likewise
translated into canonical managed element IDs. Use `element_id(variable)` to
read that graph identity.

### Property types

Common graph-header type mappings are:

| Header type | Managed DuckDB type |
| --- | --- |
| `boolean`, `bool` | `BOOLEAN` |
| `byte`, `short`, `int`, `integer`, `long` | `BIGINT` |
| `float`, `double` | `DOUBLE` |
| `string`, `char` | `VARCHAR` |
| `date` | `DATE` |
| `localtime` | `TIME_NS` |
| `localdatetime` | `TIMESTAMP_NS` |
| `datetime` | `TIMESTAMPTZ` |
| `variant` | DuckDB `VARIANT` |
| supported scalar plus `[]` | Native DuckDB `LIST` |

CSV list values use `;` as the element separator. Boolean, integer, floating,
and string lists are supported. Parquet preserves compatible native scalar and
list types rather than round-tripping them through text.

Without an explicit type, Parquet retains the source type while CSV data begins
as text. Explicit headers make the stored contract predictable across formats.

### Validation

Normal import validates that:

- vertex IDs are non-null, non-empty, and unique;
- source and destination ID groups match the vertex ID group;
- every edge endpoint resolves to an imported vertex;
- every relationship has one non-empty type;
- normalized property names do not collide;
- values convert to their declared property types.

The complete load is atomic. A failure removes staged storage and catalog
mappings, leaving the graph empty.

Trusted data can skip the expensive uniqueness and endpoint scans:

```sql
COPY GRAPH social FROM (
    VERTICES 'nodes.parquet',
    EDGES 'relationships.parquet'
) FORMAT GRAPH OPTIONS (VALIDATE FALSE);
```

`VALIDATE FALSE` is a performance trust boundary, not a relaxed graph model.
Structural headers, property conversion, and the one-edge-type invariant still
apply. Duplicate IDs or missing endpoints in trusted input can cause invalid
query and CSR behavior later, so use this mode only when upstream guarantees
have already been checked.

## Create a typed graph

An inline typed schema creates empty managed tables immediately:

```sql
CREATE GRAPH social_typed TYPED {
    (Person :Person {
        id INT64 NOT NULL,
        name STRING,
        active BOOLEAN
    }),
    (Company :Company {
        id INT64 NOT NULL,
        name STRING NOT NULL
    }),
    (Person)-[:KNOWS {
        since INT32
    }]->(Person),
    (Person)-[:WORKS_AT {
        role STRING
    }]->(Company)
};
```

Node aliases such as `Person` and `Company` identify schema elements inside the
declaration. An edge declaration references those aliases as its allowed source
and destination types.

DuckGQL maps GQL scalar declarations to native DuckDB columns. Useful families
include booleans, signed and unsigned integers from 8 through 128 bits,
`FLOAT32`, `FLOAT64`, strings, binary values, dates, times, and timestamps.
`NOT NULL` becomes a per-type storage constraint. Duplicate properties,
unknown endpoint aliases, unknown types, and incompatible declarations reject
the complete creation command.

`CREATE GRAPH IF NOT EXISTS` is idempotent by name. It does not migrate an
existing graph to a new declaration. Schema evolution remains limited; create
a new graph and migrate data when the persistent type contract must change.

## Select the graph

```sql
SESSION SET GRAPH social_typed;
```

Selection affects subsequent GQL statements on that connection. It does not
change another connection's session.

## Insert typed data

A standalone node insert allocates a canonical graph identity and writes the
declared properties:

```sql
INSERT (ada:Person {
    id: 1,
    name: 'Ada',
    active: true
});
```

A directed path creates its unbound endpoints and edges atomically:

```sql
INSERT (grace:Person {id: 2, name: 'Grace', active: true})
       -[:KNOWS {since: 2020}]->
       (barbara:Person {id: 3, name: 'Barbara', active: true});
```

`INSERT RETURN` can expose a directly inserted node using the same graph-value
shape returned by `MATCH`:

```sql
INSERT (created:Company {id: 10, name: 'Example Labs'})
RETURN created;
```

Use `MATCH` followed by `INSERT` to connect existing nodes without reinserting
them:

```sql
MATCH (person:Person), (company:Company)
WHERE person.id = 1 AND company.id = 10
INSERT (person)-[:WORKS_AT {role: 'Engineer'}]->(company);
```

Match cardinality controls mutation cardinality: one new edge is produced for
each matched row. No input rows means no writes. Conversion or constraint
failure rolls back every generated node and edge from the command.

## Update properties and labels

Property assignments use the pre-mutation row as their expression input:

```sql
MATCH (person:Person)
WHERE person.id = 1
SET person.name = 'Ada Lovelace',
    person.active = true;
```

Remove one property by setting it to `NULL` or using `REMOVE` where supported
by the mutation form:

```sql
MATCH (person:Person)
WHERE person.id = 1
REMOVE person.nickname;
```

Managed nodes store a native label list. Label additions are idempotent and
removal affects only the named label:

```sql
MATCH (person:Person)
WHERE person.id = 1
SET person:Researcher;

MATCH (person:Person)
WHERE person.id = 1
REMOVE person:Researcher;
```

An edge has one immutable scalar type. Label-style `SET` and `REMOVE` therefore
apply to nodes, not edge types.

DuckGQL also supports property-map replacement and its project-owned `+=`
merge compatibility form. Replacement clears omitted mapped properties;
merge retains them. Validate the exact map syntax against the current
[GQL surface](../reference/gql.md) before making it part of an application
contract.

## Delete graph elements

Delete an edge directly:

```sql
MATCH (:Person)-[relationship:KNOWS]->(:Person)
WHERE relationship.since < 2000
DELETE relationship;
```

Plain node deletion is constrained. It fails when an incident edge would be
left behind:

```sql
MATCH (person:Person)
WHERE person.id = 3
DELETE person;
```

Use `DETACH DELETE` when all incident edges should be removed atomically with
the node:

```sql
MATCH (person:Person)
WHERE person.id = 3
DETACH DELETE person;
```

`NODETACH DELETE` is the explicit constrained spelling. Paths and supported
collections of graph values can also be deletion targets. Deletion is
idempotent for repeated identities inside one target, and a later failure rolls
the whole command back.

## Transaction behavior

The lifecycle and data operations have different transaction boundaries:

| Operation | Explicit caller transaction |
| --- | --- |
| `CREATE GRAPH` | Not supported; autocommit only. |
| `DROP GRAPH` | Not supported; autocommit only. |
| Full-load `COPY GRAPH` | Not supported; autocommit only. |
| `MATCH` queries | Supported. |
| Supported `INSERT`, `SET`, `REMOVE`, and `DELETE` | Supported, including read-your-writes and rollback. |
| CSR construction and algorithms | Not supported; autocommit only. |

Example caller-controlled mutation:

```sql
BEGIN;

INSERT (temporary:Person {id: 999, name: 'Temporary'});

MATCH (person:Person)
WHERE person.id = 999
RETURN person.name;

ROLLBACK;
```

After rollback, the inserted node is absent. In autocommit mode, one GQL
mutation command is still atomic even when DuckGQL lowers it into several
physical writes.

## Managed storage layout

Managed graphs use graph-owned wide tables:

```text
gql_data.graph_<id>_vertices
gql_data.graph_<id>_edges
gql_internal.*
```

The vertex table contains a canonical `UBIGINT` identity, a native
`VARCHAR[]` label list, and typed property columns. The edge table contains a
canonical edge identity, source and destination identities, one scalar type,
and typed property columns.

Properties are not stored as entity-attribute-value rows. A predicate such as
`person.age >= 35` becomes an ordinary typed DuckDB column predicate.

The `__gql_` prefix is reserved for structural columns. Applications should
prefer GQL mutations. Direct SQL inspection is useful, but direct writes must
preserve identities, endpoints, labels, constraints, and graph consistency.
They also invalidate prepared CSR state.

## Drop a graph

```sql
DROP GRAPH social_typed;
```

For a managed graph, `DROP GRAPH` removes graph metadata, owned vertex and edge
tables, sequences, and related registrations. It does not leave orphan schema
metadata.

```sql
DROP GRAPH IF EXISTS social_typed;
```

For a referenced DuckLake graph, dropping removes only DuckGQL's mapping and
derived state; source tables and source data remain untouched.
