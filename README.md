# Relay style pagination aware GraphQL Query Cost Calculator
This library provides a simplified implementation of a GraphQL query cost calculator that works with the
[GraphQL Cursor Connections Specification](https://relay.dev/graphql/connections.htm).

The goal of this library is to take pagination parameters into account while calculating query cost to block database-intensive queries. 

If you take the following example query where a client requests 50 Slack accounts:
```
query ExampleQuery {
  organization {
    SlackAccountList(first:50) {
      edges {
        cursor
        node {
          displayName
        }
      }
    }
  }
}
```

The query cost might grow quadratically if the API supports nested fields. These queries can be expensive for systems but aren't caught by traditional depth or complexity checks.

```
query ExampleQuery {
  organization {
    SlackAccountList(first:1) {
      edges {
        cursor
        node {
          displayName
        }
        associatedUsers(first: 10) {
          edges {
            cursor
            node {
              userId
            }
          }
        }
      }
    }
  }
}
```

We also don't want to penalize inline fragments, so the calculator takes the maximum cost of any inline fragments.

```
query helloQuery {
  resources(first: 10) {
    str
    genericResource {
      foo
      # the cost of the employee resource will be ignored
      # because computer resource is more expensive.
      ... on EmployeeResource { 
        email
      }
      ... on ComputerResource {
        serialNumber
        hardwareUUID
      }
    }
  }
}
```



## Usage

This comes prebuilt as an Apollo Server plugin.

```
import queryCost from "graphql-query-cost";

const server = new ApolloServer({
  plugins: [
    queryCost(gqlSchema, {
      sampleRate: 1, // how many requests to take into consideration
      blockOnHighQueryCost: true, // raise an exception if a query exceeds a threshold
      costThreshold: 10_000, // cost threshold
      queryCacheSize: 1_000, // maintain an LRU cache of costs for given queries so that we don't recalculate them.
    }),
  ],
)}
```


Directives present in the schema can be configured to have a static cost associated with them.

```
type Query {
  hello(message: String!): [String!]! @tinylist
}

queryCost(gqlSchema, {
  sampleRate: 1, // how many requests to take into consideration
  blockOnHighQueryCost: true, // raise an exception if a query exceeds a threshold
  costThreshold: 10_000, // cost threshold
  queryCacheSize: 1_000, // maintain an LRU cache of costs for given queries so that we don't recalculate them.
  directiveCostConfig: {
    "tinylist": 10 // count any tinylist field with cost 10.
  },
}),
```

## Events emitted

The cost calculator invokes callbacks when it takes an action.

```
onCacheHit: () => void,
onCacheMiss: () => void,
onCostCalculated: (cost: number, document: DocumentNode, durationMs: number) => void,
onError: (e: Error) => void,
onRequestBlocked: (cost: number, document: DocumentNode) => void,
```

Pass these in as arguments.

## Development

`npm run build` to build.

`npm run lint` to lint with `eslint`.

`npm run test` to run the unit test suite with `mocha`.