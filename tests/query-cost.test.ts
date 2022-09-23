import assert from "assert";
import type { VariableValues } from "apollo-server-core";
import { buildSchema } from "graphql";
import mocha from "mocha";

import type { Maybe } from "../src/query-cost";
import { costForTesting as cost, cacheKey } from "../src/query-cost";

assert(mocha);

const exampleSchema = buildSchema(`
directive @tinylist on FIELD_DEFINITION

enum ThingsEnum {
  first
  second
  third
}

interface GenericResource {
  id: ID!
  foo: String!
}

type ComputerResource implements GenericResource {
  serialNumber: String!
}

type WindowsComputerResource implements ComputerResource {
  username: String!
  computerName: String!
  otherThing: Int!
}

type MacComputerResource implements ComputerResource {
  version: String!
}

type EmployeeResource implements GenericResource {
  email: String!
  otherAttr: Int!
  tl: [String!]! @tinylist
}

type MiscResource implements GenericResource {
  thing: String!
}

type NestedConn {
  name: String!
}

type ResourceConn {
  str: String!
  tl: [String!]! @tinylist
  conn(
    first: Int
    last: Int
  ): NestedConn!
  genericResource: GenericResource!
}

type Query {
  hello: String
  world: String
  resources(
    first: Int
    last: Int
  ): ResourceConn!
  things: ThingsEnum
}`);

type Test = {
  query: string;
  variables?: Maybe<VariableValues>;
  cost?: Maybe<number>;
  expectError?: Maybe<boolean>;
};

const tests: Test[] = [
  {
    // invalid syntax
    query: `helloQuery {
      hello
    }`,
    expectError: true,
  },
  {
    query: `subscription helloQuery {
      hello
    }`,
    expectError: true,
  },
  {
    query: `query helloQuery {
      hello
    }`,
    cost: 1,
  },
  {
    query: `query helloQuery {
      hello
    }
    query helloQuery2 {
      hello
    }
    `,
    cost: 2,
    // should handle multi operation queries.
  },
  {
    query: `mutation helloQuery {
      hello
    }`,
    cost: 11,
  },
  {
    query: `query helloQuery {
      hello
    }
    mutation helloQuery2 {
      hello
    }`,
    cost: 12,
  },
  {
    query: `query helloQuery {
      hello
      world
    }`,
    cost: 2,
  },
  {
    query: `query helloQuery {
      hello
      world
      things
    }`,
    cost: 3,
  },
  {
    query: `query helloQuery {
      resources(first: 1) {
        str
      }
    }`,
    cost: 2,
    // resources = 1
    // str       = 1
    //             _
    //           = 2
  },
  {
    query: `query helloQuery {
      resources(first: 10) {
        str
      }
    }`,
    cost: 11,
    // resources = 1 * 1
    // str       = 1 * 10
    //             _
    //           = 11
  },
  {
    query: `query helloQuery {
      resources(first: 10) {
        conn(
          last: 50
        ) {
          name
        }
      }
    }`,
    cost: 511,
    // resources = 1 * 1
    // conn      = 1 * 10
    // name      = 1 * 10 * 50
    //             _
    //           = 511
  },
  {
    query: `query helloQuery {
        resources(first: 10, last: 15) {
          str
        }
      }
    `,
    expectError: true,
  },
  {
    query: `query helloQuery {
        resources(first: 1) {
          tl
        }
      }`,
    cost: 11,
    // resources = 1  * 1
    // tl        = 10 * 1
    //             _
    //           = 11
  },
  {
    query: `query helloQuery {
        resources(first: 1) {
          str
          tl
        }
      }`,
    cost: 12,
    // resources = 1  * 1
    // str       = 1  * 1
    // tl        = 10 * 1
    //             _
    //           = 12
  },
  {
    query: `query helloQuery {
        resources(first: 10) {
          str
          tl
        }
      }`,
    cost: 111,
    // resources = 1  * 1
    // str       = 1  * 10
    // tl        = 10 * 10
    //             _
    //           = 111
  },
  {
    query: `query helloQuery {
        resources(first: 1) {
          str
          genericResource {
            foo
            ... on EmployeeResource {
              email
            }
          }
        }
      }`,
    cost: 5,
    // resources       = 1  * 1
    // genericResource = 1  * 1
    // str             = 1  * 1
    // foo             = 1  * 1
    // email           = 1  * 1
    //                   _
    //                 = 5
  },
  {
    query: `query helloQuery {
        resources(first: 10) {
          str
          genericResource {
            foo
            ... on EmployeeResource {
              email
            }
          }
        }
      }`,
    cost: 41,
    // resources       = 1  * 1
    // genericResource = 1  * 10
    // str             = 1  * 10
    // foo             = 1  * 10
    // email           = 1  * 10
    //                   _
    //                 = 41
  },
  {
    query: `query helloQuery {
        resources(first: 10) {
          str
          genericResource {
            foo
            ... on EmployeeResource {
              email
            }
            ... on ComputerResource {
              serialNumber
              hardwareUUID
            }
          }
        }
      }`,
    cost: 51,
    // resources                                = 1  * 1
    // str                                      = 1  * 10
    // genericResource                          = 1  * 10
    // foo                                      = 1  * 10
    // max (EmployeeResource, ComputerResource) = (1  * 10, 2 * 10)
    //                                            _
    //                                          = 51
  },
  {
    query: `query helloQuery {
        resources(first: 10) {
          str
          genericResource {
            foo
            ... on EmployeeResource {
              email
              otherAttr
            }
            ... on ComputerResource {
              serialNumber
              hardwareUUID
              ... on WindowsComputerResource {
                username
                computerName
                otherThing
              }
              ... on MacComputerResource {
                version
              }
            }
          }
        }
      }`,
    cost: 81,
    // resources                                          = 1  * 1
    // str                                                = 1  * 10
    // genericResource                                    = 1  * 10
    // foo                                                = 1  * 10
    // max (EmployeeResource, ComputerResource)           = (1  * 10, 2 * 10)
    // max (MacComputerResource, WindowsComputerResource) = (1  * 10, 3 * 10)
    //                                                      _
    //                                                    = 81
  },
  {
    query: `query helloQuery {
        resources(first: 10) {
          genericResource {
            ... on EmployeeResource {
              email
            }
            ... on ComputerResource {
              serialNumber
              hardwareUUID
            }
            ... on MiscResource {
              thing
            }
          }
        }
      }`,
    cost: 31,
  },
  {
    query: `query helloQuery {
        resources(first: 10) {
          genericResource {
            ... on EmployeeResource {
              tl
            }
          }
        }
      }`,
    cost: 111,
  },
  {
    query: `query helloQuery {
        resources(first: 10) {
          genericResource {
            ... on EmployeeResource {
              name
              tl
            }
          }
        }
      }`,
    cost: 121,
  },
  {
    query: `
      fragment F on Query {
        resources(first: 1000) {
          str
        }
      }
      query helloQuery {
        ...F
      }`,
    cost: 1001,
  },
  {
    query: `
      query helloQuery {
        ...F
      }
      fragment F on Query {
        resources(first: 1000) {
          str
        }
      }
      `,
    cost: 1001,
  },
  {
    query: `
      query helloQuery {
        ...F
      }
      fragment F on Query {
        resources(first: 1000) {
          str
          tl
        }
      }
      `,
    cost: 11001,
  },
  // variables
  {
    query: `
      query helloQuery($first: Int) {
        resources(first: $first) {
          str
        }
      }`,
    variables: {
      first: 10,
    },
    cost: 11,
  },
  // a pagination parameter has a non int type.
  // we expect the schema validation error to catch this if it's buggy
  // but we don't include this in pagination calculation.
  {
    query: `
      query helloQuery($first: String) {
        resources(first: $first) {
          str
        }
      }`,
    variables: {
      first: "foo",
    },
    cost: 2,
  },
  {
    query: `
      query GithubAccountList {
        organization {
          GithubAccountList(first: 100) {
            totalCount
            edges {
              cursor
              node {
                accountName
                accountId
                mfa
                role
              }
            }
          }
          GCPRoleGrantList(first: 100) {
            totalCount
          }
        }
      }`,
    cost: 903,
  },
  // organization                                       = 1  * 1
  // GithubAccountList                                  = 1  * 1
  // totalCount                                         = 1  * 100
  // edges                                              = 1  * 100
  // cursor                                             = 1  * 100
  // node                                               = 1  * 100
  // accountName                                        = 1  * 100
  // accountId                                          = 1  * 100
  // mfa                                                = 1  * 100
  // role                                               = 1  * 100
  // GCPRoleGrantList                                   = 1  * 1
  // totalCount                                         = 1  * 100
  //                                                      _
  //                                                    = 903
  {
    query: `
      query GithubAccountList {
        resources {
          foo {
            id
          }
          bar {
            id
          }
        }
      }`,
    cost: 5,
  },
  // resources                                          = 1  * 1
  // foo                                                = 1  * 1
  // id                                                 = 1  * 1
  // bar                                                = 1  * 1
  // id                                                 = 1  * 1
  //                                                      _
  //                                                    = 5
  {
    query: `
      query GithubAccountList {
        resources {
          foo(first: 10) {
            id {
              bar(first: 20) {
                id
                baz(first: 30) {
                  id
                }
                qux(first: 40) {
                  id
                }
              }
            }
           }
        }
      }`,
    cost: 14622,
  },
  // resources                                          = 1  * 1
  // foo                                                = 1  * 1
  // id                                                 = 1  * 10
  // bar                                                = 1  * 10
  // id                                                 = 1  * 200
  // baz                                                = 1  * 200
  // id                                                 = 1  * 6000
  // quix                                               = 1 * 200
  // id                                                 = 1 * 8000
  //                                                      _
  //                                                    = 14622

  /* Explanation of previous three test cases and how we resolved a bug with query cost when there were multiple queries:

    Previously, we were not calculating queries that would have to separate "nested" query arguments under the same parent
    which would effectively result in the cost being the product of them rather than the sum

    The root cause of this was essentially because of a bug in Pagination Factor where we were iterating through a specific
    type of array object we shouldn't have been (a SelectionSet type object) which would include both nests and treat them as
    if the first one was the parent of the second one, etc... The fix was to actually not iterate through array objects and to
    ignore them since the apollo library works by first adding the array object and then the individual entries used in the path
    after that inside of the ancestors array

    As an example, take a lot at the following query:

    {
      query: `
        query GithubAccountList {
          resources {
            foo {
              id
            }
            bar {
              id
            }
          }
        }`,
      cost: 5,
  }

  Apollo would output ancestors as follows essentially for foo's id for example:
  [array[GithubAccountList], GithubAccountList, array[resources,], resources, [foo, bar], foo, [id], id];

  Thus, if we just ignore the array objects and only look at the base ancestor objects that are already field types (rather
  than first checking they are an array and iterating through them) and just look at its arguments which have what we need
  already we prevent this error

  This is also the reason why this bug was not an issue with single nested queries since the array would always be size 1
  and not lead to a multiplication of the factors
  - AveekD
  */
];

describe("query cost", () => {
  tests.forEach((t, i) => {
    it(`works for case ${i + 1}`, () => {
      if (t.expectError) {
        assert.throws(() => {
          cost(exampleSchema, t.query, t.variables);
        });
      } else {
        assert.deepStrictEqual(
          cost(exampleSchema, t.query, t.variables),
          t.cost,
          `Failed query: ${t.query}\n`
        );
      }
    });
  });
});

describe("query cost caching", () => {
  it("caches appropriately in ignored cases", () => {
    const noopKey = cacheKey("", {});
    assert.deepStrictEqual(noopKey, cacheKey("", {}));
    assert.deepStrictEqual(noopKey, cacheKey("\n", {}));
    assert.deepStrictEqual(
      noopKey,
      cacheKey("\n", {
        randomVar: "foo",
      })
    );
    assert.deepStrictEqual(noopKey, cacheKey("\t", {}));
    assert.deepStrictEqual(noopKey, cacheKey(" ", {}));
  });
  it("ignores variable order", () => {
    assert.deepStrictEqual(
      cacheKey("", { first: 1, last: 1 }),
      cacheKey("", { last: 1, first: 1 })
    );
    assert.deepStrictEqual(
      cacheKey("", { last: 1, first: 1 }),
      cacheKey("", { first: 1, last: 1 })
    );
  });
  it("takes pagination parameters into account", () => {
    assert.notDeepStrictEqual(
      cacheKey("", { first: 1 }),
      cacheKey("", { last: 1, first: 1 })
    );
    assert.notDeepStrictEqual(
      cacheKey("", { last: 1 }),
      cacheKey("", { last: 1, first: 1 })
    );
  });
  it("takes query into account", () => {
    // questionable that these should have different keys, but we don't want to get too fancy
    // in the cache check.
    assert.notDeepStrictEqual(
      cacheKey("query foo { resources { id } }", {}),
      cacheKey("query bar { resources { id } }", {})
    );
    assert.notDeepStrictEqual(
      cacheKey("query foo { resources { id } }", {}),
      cacheKey("query foo { resources { id name } }", {})
    );
  });
});
