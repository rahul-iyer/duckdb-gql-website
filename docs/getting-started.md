# Getting started

The fastest way to explore DuckGQL is the
[browser playground](https://duckgql.com/). It runs DuckDB-Wasm, DuckGQL, and
the sample graph locally in your browser.

On phones, the playground uses a touch-friendly query editor with a Run button
and inline results instead of requiring input through the terminal's hidden
text field.

## Build from source

DuckGQL currently targets DuckDB `v1.5.5` and uses C++17 and ANTLR `4.13.2`.

```sh
git clone --recurse-submodules https://github.com/rahul-iyer/duckdb-gql.git
cd duckdb-gql

make setup-vcpkg
VCPKG_TOOLCHAIN_PATH="$PWD/vcpkg/scripts/buildsystems/vcpkg.cmake" make release
./build/release/duckdb
```

The locally built DuckDB shell has DuckGQL preloaded.

## Create your first graph

Create two graph-header CSV files.

`nodes.csv`:

```csv
personId:ID(People),name:string,age:int,:LABEL
p1,Ada,42,Person
p2,Grace,37,Person
```

`relationships.csv`:

```csv
:START_ID(People),:END_ID(People),:TYPE,since:int
p1,p2,KNOWS,2020
```

Create, load, select, and query the graph:

```sql
CREATE GRAPH social ANY;

COPY GRAPH social FROM (
    VERTICES 'nodes.csv',
    EDGES 'relationships.csv'
) FORMAT GRAPH;

SESSION SET GRAPH social;

MATCH (a:Person)-[e:KNOWS]->(b:Person)
WHERE e.since >= 2020
RETURN a.name AS source_name,
       e.since AS since,
       b.name AS target_name;
```

## Inspect the graph

```sql
SELECT * FROM gql_graphs();
```

Continue with [graph lifecycle and import](./guides/graph-lifecycle.md), then
learn how to [query graphs](./guides/querying.md). To query existing lakehouse
tables in place, see [DuckLake-backed graphs](./guides/ducklake.md).

::: info Prebuilt artifacts
GitHub Actions produces platform-specific extension artifacts. DuckDB
extensions are version- and platform-specific, and development artifacts are
unsigned. Use the artifact that matches your DuckDB build and only load native
binaries from a source you trust.
:::
