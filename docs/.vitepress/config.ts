import { defineConfig } from "vitepress";

export default defineConfig({
  lang: "en-US",
  title: "DuckGQL",
  description: "Graph queries and algorithms in DuckDB",
  base: "/docs/",
  outDir: "../dist/docs",
  head: [
    ["meta", { name: "theme-color", content: "#080b0d" }],
    ["link", { rel: "icon", href: "/docs/favicon.svg", type: "image/svg+xml" }]
  ],
  sitemap: {
    hostname: "https://duckgql.com/docs/"
  },
  themeConfig: {
    logo: "/favicon.svg",
    siteTitle: "DuckGQL Docs",
    nav: [
      { text: "Guide", link: "/getting-started" },
      { text: "Reference", link: "/reference/gql" },
      { text: "Playground", link: "https://duckgql.com/" }
    ],
    sidebar: [
      {
        text: "Introduction",
        items: [
          { text: "Overview", link: "/" },
          { text: "Getting started", link: "/getting-started" }
        ]
      },
      {
        text: "Guides",
        items: [
          {
            text: "Graph lifecycle and import",
            link: "/guides/graph-lifecycle"
          },
          {
            text: "DuckLake-backed graphs",
            link: "/guides/ducklake"
          },
          { text: "Querying graphs", link: "/guides/querying" },
          {
            text: "Indexes and optimization",
            link: "/guides/indexes-and-optimization"
          },
          {
            text: "CSR and algorithms",
            link: "/guides/csr-and-algorithms"
          }
        ]
      },
      {
        text: "Reference",
        items: [
          { text: "GQL surface", link: "/reference/gql" },
          {
            text: "Compatibility and limitations",
            link: "/reference/limitations"
          }
        ]
      }
    ],
    search: {
      provider: "local"
    },
    socialLinks: [
      {
        icon: "github",
        link: "https://github.com/rahul-iyer/duckdb-gql"
      }
    ],
    editLink: {
      pattern:
        "https://github.com/rahul-iyer/duckdb-gql-website/edit/main/docs/:path",
      text: "Edit this page on GitHub"
    },
    outline: {
      level: [2, 3],
      label: "On this page"
    },
    footer: {
      message: "DuckGQL is experimental software released under the MIT License.",
      copyright: "Copyright © 2026 Rahul Iyer"
    }
  }
});
