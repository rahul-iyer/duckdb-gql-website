# Querying graphs

DuckGQL parses GQL, binds graph variables and properties against the selected
graph, and lowers the result into DuckDB relational plans. Scans, joins,
filters, aggregation, sorting, and paging therefore run through DuckDB's
execution engine rather than a separate graph query engine.

This guide covers the supported query model. DuckGQL implements a growing GQL
subset, so consult [compatibility and limitations](../reference/limitations.md)
before relying on an advanced ISO GQL feature.

## Select a graph

`MATCH` uses the graph selected by the current connection:

```sql
SESSION SET GRAPH social;
```

Selection is connection state. Another connection must select its own graph.
The graph itself and its managed or referenced table mappings persist in the
database.

List available graphs before selecting one:

```sql
SELECT graph_name,
       graph_version,
       vertex_count,
       edge_count,
       created_at
FROM gql_graphs()
ORDER BY graph_name;
```

## Read a graph pattern

A pattern binds nodes with parentheses and edges with square brackets:

```sql
MATCH (person:Person)-[relationship:KNOWS]->(friend:Person)
RETURN person.name, friend.name, relationship.since;
```

| Syntax | Meaning |
| --- | --- |
| `(person)` | Any node, bound to `person`. |
| `(person:Person)` | A node carrying the `Person` label. |
| `-[relationship]->` | An outgoing edge bound to `relationship`. |
| `-[relationship:KNOWS]->` | An outgoing edge of type `KNOWS`. |
| `<-[relationship]-` | Match an incoming edge. |
| `-[relationship]-` | Match either orientation. |
| `()` or `[]` | Anonymous element that participates without creating a variable. |

Labels and relationship types constrain the match; they are not returned as
ordinary properties. Managed nodes can carry several labels, while every edge
has exactly one relationship type.

Variables refer to graph values. A returned node is a struct containing its
element ID, labels, and mapped properties. A returned edge contains its edge
ID, type, and endpoint IDs. Return individual properties when a stable tabular
shape is preferable:

```sql
MATCH (person:Person)
RETURN element_id(person) AS person_element_id,
       person.id AS business_id,
       person.name AS name;
```

`element_id(person)` is DuckGQL's graph identity. A property such as
`person.id` is application data and may have a different value or type.

## Direction and repeated variables

Direction is part of pattern semantics:

```sql
MATCH (destination:Person)<-[relationship:KNOWS]-(source:Person)
RETURN source.name, destination.name;
```

An undirected edge pattern returns both valid orientations. This can produce
two rows for one non-self edge because each endpoint can bind to either side:

```sql
MATCH (a:Person)-[relationship:KNOWS]-(b:Person)
RETURN a.name, b.name;
```

Reusing a variable means identity equality rather than a new independent
binding. The following finds two-hop cycles back to the same node:

```sql
MATCH (person:Person)-[:KNOWS]->()-[:KNOWS]->(person)
RETURN person.name;
```

Within one path pattern, DuckGQL applies `TRAIL` semantics: the same edge may
not be reused at two positions in that path. Separate patterns can reuse an
edge unless another predicate prevents it.

## Filter rows

`WHERE` can follow a `MATCH`, and `FILTER` can be used in a linear clause
pipeline:

```sql
MATCH (person:Person)-[relationship:KNOWS]->(friend:Person)
WHERE person.active = true
  AND relationship.since >= 2020
  AND friend.name <> person.name
RETURN person.name, friend.name;
```

```sql
MATCH (person:Person)
FILTER person.age >= 35
MATCH (person)-[:KNOWS]->(friend:Person)
FILTER friend.active = true
RETURN person.name, friend.name;
```

Clauses bind in source order. A filter can use variables introduced earlier,
but cannot refer to a variable introduced by a later clause.

Missing nullable properties evaluate to `NULL`. Ordinary three-valued SQL
logic applies: a `WHERE` or `FILTER` predicate keeps only rows for which the
condition is `TRUE`.

DuckGQL supports typed scalar expressions through DuckDB, including arithmetic,
comparisons, boolean operators, string concatenation, `COALESCE`, and functions
such as `LOWER`, `UPPER`, `TRIM`, `LEFT`, `RIGHT`, `CHAR_LENGTH`, and `MOD`:

```sql
MATCH (person:Person)
RETURN UPPER(person.name) AS display_name,
       COALESCE(person.nickname, person.name, 'unknown') AS preferred_name,
       MOD(person.age, 10) AS age_last_digit;
```

## Compose mandatory matches

Multiple comma-separated patterns in one `MATCH` form one mandatory stage:

```sql
MATCH (person:Person)-[:KNOWS]->(friend:Person),
      (friend)-[:WORKS_AT]->(company:Company)
WHERE person.name = 'Ada'
RETURN friend.name, company.name;
```

Sequential `MATCH` clauses can correlate through variables already in scope:

```sql
MATCH (person:Person)
WHERE person.name = 'Ada'
MATCH (person)-[:KNOWS]->(friend:Person)
MATCH (friend)-[:WORKS_AT]->(company:Company)
RETURN friend.name, company.name;
```

Mandatory fixed-pattern regions lower to ordinary inner-join relations. DuckDB
can reorder that join island while DuckGQL preserves variable identity and
pattern predicates.

Disconnected patterns produce a Cartesian product unless a predicate joins
them. Apply selective filters early and deliberately when querying large
graphs.

## Preserve rows with `OPTIONAL MATCH`

`OPTIONAL MATCH` behaves like a correlated left outer match. Every incoming row
survives; variables introduced only by a missing optional pattern become
`NULL`:

```sql
MATCH (person:Person)
OPTIONAL MATCH (person)-[:KNOWS]->(friend:Person)
RETURN person.name, friend.name;
```

The location of a predicate matters. A predicate attached to the optional
stage decides whether that stage matched, but does not discard its left input:

```sql
MATCH (person:Person)
OPTIONAL MATCH (person)-[:KNOWS]->(friend:Person)
WHERE friend.active = true
RETURN person.name, friend.name;
```

People with no active friend remain, with `friend` set to `NULL`. A later
mandatory stage that consumes a null optional binding eliminates that row,
because the mandatory pattern cannot match a null endpoint.

`LET` introduces a named scalar and establishes a clause boundary:

```sql
MATCH (person:Person)
OPTIONAL MATCH (person)-[:KNOWS]->(friend:Person)
LET friend_age = friend.age
FILTER friend_age >= 35
RETURN person.name, friend.name;
```

Here the `FILTER` is after the optional join, so null-extended rows do not pass.
This differs from a predicate owned by the `OPTIONAL MATCH` itself.

## Fixed-length paths

Write each hop explicitly when its intermediate variables or properties are
needed:

```sql
MATCH (source:Person)-[first:KNOWS]->(middle:Person)
      -[second:KNOWS]->(target:Person)
WHERE source.id = 123
RETURN middle.name,
       target.name,
       first.since,
       second.since;
```

A named fixed path returns an ordered node/edge struct:

```sql
MATCH path = (source:Person)-[relationship:KNOWS]->(target:Person)
WHERE source.id = 123
RETURN path;
```

Path values are currently supported for fixed patterns. Projecting a named
quantified path value is not yet implemented.

## Quantified and unbounded paths

Quantifiers follow the edge pattern:

| Quantifier | Repetitions |
| --- | --- |
| `{2}` | Exactly two. |
| `{1,3}` | One through three. |
| `{2,}` | Two or more. |
| `+` | One or more. |
| `*` | Zero or more. |

```sql
MATCH (source:Person)-[:KNOWS]->{1,3}(target:Person)
WHERE source.id = 123
RETURN DISTINCT target.name
ORDER BY target.name;
```

Different path lengths are combined before `DISTINCT`, ordering, offset, and
limit are applied. Without `DISTINCT`, the same endpoint may occur more than
once when reached by different paths or lengths.

`*` includes a zero-hop result, so the source can also bind as the target:

```sql
MATCH (source:Person)-[:KNOWS]->*(target:Person)
WHERE source.id = 123
RETURN element_id(target), target.name;
```

Finite ranges can run through relational expansion without a prepared CSR.
Some composed unbounded path shapes require a current CSR snapshot; the error
will request `CALL gql_build_csr('graph_name')` when that boundary is reached.
Path search modes, shortest-path groups, and the full ISO GQL path surface are
not yet complete.

## Project and shape results

Use aliases to give expressions stable result names:

```sql
MATCH (person:Person)-[:KNOWS]->(friend:Person)
RETURN person.name AS person_name,
       friend.name AS friend_name;
```

`RETURN *` expands currently visible variables in ascending name order. It is
convenient for exploration but explicit columns are safer for application
contracts.

`DISTINCT` applies to the complete returned row:

```sql
MATCH (:Person)-[:KNOWS]->(friend:Person)
RETURN DISTINCT friend.name AS friend_name;
```

`ORDER BY` can use a non-returned expression when the result is not distinct:

```sql
MATCH (person:Person)
RETURN person.name
ORDER BY person.age DESC;
```

With `DISTINCT` or an algorithm `CALL`, every ordering expression must appear
in the returned shape. Add a deterministic tie-breaker when paginating:

```sql
MATCH (person:Person)
RETURN person.name, element_id(person) AS person_id
ORDER BY person.name, person_id
OFFSET 20
LIMIT 10;
```

Without `ORDER BY`, row order is not an application-level guarantee.

## Aggregate

Supported aggregate use includes `COUNT`, `SUM`, `AVG`, `MIN`, `MAX`, and
distinct aggregate arguments:

```sql
MATCH (person:Person)-[:KNOWS]->(friend:Person)
RETURN person.name,
       COUNT(*) AS relationship_count,
       COUNT(DISTINCT friend.name) AS distinct_friend_names,
       MIN(friend.age) AS youngest_friend,
       AVG(friend.age) AS average_friend_age
GROUP BY person
ORDER BY relationship_count DESC, person.name;
```

Group by the graph variable when returning one of its properties. DuckGQL
resolves that variable to its stable element identity, so two different nodes
with the same `name` do not collapse accidentally.

An aggregate without grouping returns one row even for an empty match. For
example, `COUNT(*)` returns 0.

## Understand graph values and nullability

Returning a whole node or edge is useful for inspection:

```sql
MATCH (person:Person)-[relationship:KNOWS]->(friend:Person)
RETURN person, relationship, friend
LIMIT 1;
```

For durable schemas, return element IDs and explicit properties instead. Whole
element structs can gain or lose fields when the graph mapping changes.

Values introduced by `OPTIONAL MATCH` are nullable. Property access and
`element_id()` on a null graph value return `NULL`, allowing standard
`COALESCE` and `IS NULL` handling.

## Explain execution

DuckGQL supports standard, analyzed, and JSON plans for read-only `MATCH` and
algorithm calls:

```sql
EXPLAIN MATCH (person:Person)
WHERE person.age >= 35
RETURN person.name;

EXPLAIN ANALYZE MATCH (person:Person)
RETURN person.name;

EXPLAIN (FORMAT JSON) MATCH (person:Person)
RETURN person.name;
```

The plan is shown after GQL lowering. You will see authoritative graph tables,
DuckDB scans and joins, and—when selected—property-index scans, CSR expansion,
or batched element fetches. `EXPLAIN ANALYZE` executes the query and adds
runtime measurements; do not use it for a statement whose effects you are not
prepared to execute.

For how those access paths are selected, continue with
[indexes and optimization](./indexes-and-optimization.md). For topology-wide
analysis, see [CSR and graph algorithms](./csr-and-algorithms.md).
