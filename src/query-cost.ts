import crypto from "crypto";

import type { GraphQLRequest } from "apollo-server-core";
import type { ApolloServerPlugin } from "apollo-server-plugin-base";
import EventEmitter from "events";
import TypedEmitter from "typed-emitter";

import type { VariableValues } from "apollo-server-types";

import stringify from "fast-json-stable-stringify";

import type {
  ASTNode,
  DocumentNode,
  FieldNode,
  GraphQLSchema,
  InlineFragmentNode,
  OperationDefinitionNode,
  SelectionNode,
} from "graphql";

import {
  GraphQLError,
  parse,
  stripIgnoredCharacters,
  TypeInfo,
  ValidationContext,
  visit,
  visitWithTypeInfo,
} from "graphql";

import { getVariableValues } from "graphql/execution/values";
import { pick } from "lodash";

export type Maybe<T> = T | null | undefined;

function isSome<T>(arg: Maybe<T>): arg is NonNullable<T> {
  return arg !== null && arg !== undefined;
} 

class QueryCostTooHighError extends Error {
  public constructor(calculatedCost: number, threshold: number) {
    super(
      `Blocked request because calculated cost too high. Calculated: ${calculatedCost}, threshold ${threshold}`
    );
  }
}

// Defines a capped map with least-recently-used eviction strategy
// key idea is from here: https://medium.com/sparkles-blog/a-simple-lru-cache-in-typescript-cba0d9807c40
// javascript maps retain insertion order.
export class LruMap<U, V> {
  private readonly maxCapacity: number;
  private readonly backingMap: Map<U, V>;

  constructor(maxCapacity: number) {
    this.maxCapacity = maxCapacity;
    this.backingMap = new Map<U, V>();
  }

  public get(key: U): Maybe<V> {
    const entry = this.backingMap.get(key);
    if (isSome(entry)) {
      // peek the entry, re-insert for LRU strategy
      this.backingMap.delete(key);
      this.backingMap.set(key, entry);
    }
    return entry;
  }

  public set(key: U, value: V) {
    if (this.backingMap.size >= this.maxCapacity) {
      const keyToDelete = this.backingMap.keys().next().value;
      this.backingMap.delete(keyToDelete);
    }
    this.backingMap.set(key, value);
  }
}

const TINYLIST_COST = 10;

// tinylists have a fixed cost.
function getDirectiveCost(validationContext: ValidationContext): Maybe<number> {
  const hasTinyList = validationContext
    .getFieldDef()
    ?.astNode?.directives?.find(({ name }) => name.value === "tinylist");

  return isSome(hasTinyList) ? TINYLIST_COST : null;
}

type Ancestor = ASTNode | readonly ASTNode[];

function isNode(arg: Ancestor): arg is ASTNode {
  return !Array.isArray(arg);
}

function isASTArray(arg: Ancestor): arg is readonly ASTNode[] {
  return Array.isArray(arg);
}

// computes the total number of items actually returned for paginated queries.
// resources(first: 50) {
//   foo
//   conn(last: 10) {
//     bar
//   }
// }
// paginationFactor(resources) == 1
// paginationFactor(foo)       == 50
// paginationFactor(conn)      == 50
// paginationFactor(bar)       == 500
function paginationFactor(
  context: ValidationContext,
  ancestors: readonly Ancestor[],
  variables: VariableValues
): number {
  let factor = 1;
  ancestors.forEach(ancestor => {
    if (isASTArray(ancestor)) {
      return;
    }
    if (ancestor.kind !== "Field") {
      return;
    }
    let hasFirst = false;
    let hasLast = false;
    ancestor.arguments?.forEach(arg => {
      switch (arg.name.value) {
        case "first":
          hasFirst = true;
          break;
        case "last":
          hasLast = true;
          break;
        default:
          return;
      }
      let val = NaN;
      switch (arg.value.kind) {
        case "IntValue": {
          val = parseInt(arg.value.value, 10);
          if (isNaN(val)) {
            context.reportError(
              new GraphQLError(
                `Unexpected non number in IntVal: ${arg.name.value}`
              )
            );
            return;
          }
          break;
        }
        case "Variable": {
          val = parseInt(variables[arg.value.name.value], 10);
          if (isNaN(val)) {
            // not a pagination parameter, even though this is named $first or $last
            // bail out of pagination calculations.
            return;
          }
          break;
        }
        default: {
          return;
        }
      }
      factor *= val;
    });
    if (hasFirst && hasLast) {
      context.reportError(
        new GraphQLError(
          `Received both first and last parameters; cannot cost: ${ancestor.name.value}`
        )
      );
    }
  });
  return factor;
}

type InlineFragmentCost = {
  inlineFragmentCost: number;
};

function hasInlineFragmentCost(
  n: SelectionNode | InlineFragmentCost
): n is InlineFragmentCost {
  return "inlineFragmentCost" in n;
}

type IntermediateCost = {
  currentCost: number;
};

function hasIntermediateCost(
  n: FieldNode | SelectionNode
): n is (FieldNode | SelectionNode) & IntermediateCost {
  return "currentCost" in n;
}

function assertIntermediateCost(
  n: FieldNode | SelectionNode
): asserts n is (FieldNode | SelectionNode) & IntermediateCost {
  if (!hasIntermediateCost(n)) {
    throw new Error(`no intermediate cost! ${n.kind}`);
  }
}

// we like distinguishing these cases because
// we might not be adding up the cost of each descendant, but instead taking the max of
// children
function isDirectDescendentOfInlineFragment(
  ancestors: readonly Ancestor[]
): boolean {
  if (ancestors.length > 1) {
    const parent = ancestors[ancestors.length - 2];
    if (isNode(parent) && parent.kind === "InlineFragment") {
      return true;
    }
  }
  return false;
}

const supportedOperations: readonly string[] = ["query", "mutation"] as const;

function documentCost(
  schema: GraphQLSchema,
  query: DocumentNode,
  requestVariables: Maybe<VariableValues>
): number {
  const typeInfo = new TypeInfo(schema);
  type error = { message: string };
  const errors: error[] = [];
  const validationContext: ValidationContext = new ValidationContext(
    schema,
    query,
    typeInfo,
    (e: error) => {
      errors.push(e);
    }
  );

  let cost = 0;
  let variables: VariableValues = {};
  // we slightly modify ASTs along the way to keep track of cost for a given field.
  const visitor = {
    Field: {
      enter(
        node: FieldNode,
        key: Maybe<string | number>,
        parent: Maybe<ASTNode | readonly ASTNode[]>,
        path: ReadonlyArray<string | number>,
        ancestors: ReadonlyArray<ASTNode | readonly ASTNode[]>
      ) {
        const factor = paginationFactor(
          validationContext,
          ancestors,
          variables
        );
        const itemCost = getDirectiveCost(validationContext) ?? 1;
        return {
          ...node,
          currentCost: factor * itemCost,
        };
      },
      leave(
        node: FieldNode,
        key: Maybe<string | number>,
        parent: Maybe<ASTNode | readonly ASTNode[]>,
        path: ReadonlyArray<string | number>,
        ancestors: ReadonlyArray<ASTNode | readonly ASTNode[]>
      ) {
        assertIntermediateCost(node);
        // we don't want to take direct field costs of inline fragments, but the max
        // of its children. So skip here. The next section will calculate cost for children fragments.
        if (!isDirectDescendentOfInlineFragment(ancestors)) {
          cost += node.currentCost;
        }
        let maxCost = 0;
        node.selectionSet?.selections.forEach(
          (n: SelectionNode | InlineFragmentCost) => {
            if (hasInlineFragmentCost(n)) {
              maxCost =
                maxCost > n.inlineFragmentCost ? maxCost : n.inlineFragmentCost;
            }
          }
        );
        cost += maxCost;
      },
    },
    InlineFragment: {
      leave(node: InlineFragmentNode) {
        // this is a tricky one.
        // if a given node has multiple inline fragment children, we want to take the maximum cost of each inline fragment
        // rather than adding the cost of all children. This is made more complicated since inline fragments can have
        // inline fragment children recursively. So handle both cases here.
        let inlineFragmentCost = 0;
        let maxRecursiveInlineFragmentCost = 0;
        node.selectionSet.selections.forEach((n: SelectionNode) => {
          if (hasInlineFragmentCost(n)) {
            maxRecursiveInlineFragmentCost =
              n.inlineFragmentCost > maxRecursiveInlineFragmentCost
                ? n.inlineFragmentCost
                : maxRecursiveInlineFragmentCost;
          } else if (hasIntermediateCost(n)) {
            inlineFragmentCost += n.currentCost;
          } else {
            throw new Error(`Unexpected node kind child: ${n.kind}`);
          }
        });
        inlineFragmentCost += maxRecursiveInlineFragmentCost;
        return {
          ...node,
          inlineFragmentCost,
        };
      },
    },
    OperationDefinition: {
      enter(node: OperationDefinitionNode) {
        if (!supportedOperations.includes(node.operation)) {
          throw new Error(
            `Can only calculate cost for "query" and "mutation" operations, got ${node.operation}`
          );
        }
        // make mutations unilaterally a little more expensive since they put more load on
        // our datastores.
        if (node.operation === "mutation") {
          cost += 10;
        }

        variables =
          getVariableValues(
            schema,
            node.variableDefinitions ? [...node.variableDefinitions] : [],
            requestVariables ?? {}
          ).coerced ?? {};
      },
    },
  };

  visit(query, visitWithTypeInfo(typeInfo, visitor));

  if (errors.length > 0) {
    throw new Error(errors.map(e => e.message).join(","));
  }

  return cost;
}

// exported only for testing.
export function costForTesting(
  schema: GraphQLSchema,
  queryStr: string,
  variables: Maybe<VariableValues>
) {
  const query = parse(queryStr, {
    noLocation: true,
  });
  return documentCost(schema, query, variables);
}

export function cacheKey(req: string, variables: VariableValues) {
  // only use pagination parameters we support for cache keys.
  // for example, we don't want cursor parameters to be cached since they'll always change.
  const cacheVars = pick(variables ?? {}, ["first", "last"]);

  // construct a hash from the request & pagination parameters if present.
  return (
    crypto
      .createHash("md5")
      .update(stripIgnoredCharacters(req))
      // add a separator just for safety
      .update("|")
      .update(stringify(cacheVars))
      .digest("hex")
  );
}

type Events = {
  cache_hit: () => void,
  cache_miss: () => void,
  cost_calculated: (cost: number, document: DocumentNode, durationMs: number) => void,
  error: (e: Error) => void,
  blocked_request: () => void,
}

export const emitter = new EventEmitter() as TypedEmitter<Events>;

function getCost(
  schema: GraphQLSchema,
  document: DocumentNode,
  request: GraphQLRequest,
  cachedCosts: LruMap<string, number>
): number {
  const req = document?.loc?.source.body;
  if (!isSome(req)) {
    return 0;
  }
  const key = cacheKey(req, request.variables ?? {});
  const cachedCost = cachedCosts.get(key);
  if (isSome(cachedCost)) {
    emitter.emit("cache_hit")
    return cachedCost;
  }
  emitter.emit("cache_miss")
  const start = Date.now();
  const cost = documentCost(schema, document, request.variables);
  const durationMs = Date.now() - start;
  cachedCosts.set(key, cost);
  emitter.emit("cost_calculated", cost, document, durationMs)
  return cost;
}

export default function queryCost(
  schema: GraphQLSchema,
  {
    costThreshold,
    sampleRate,
    blockOnHighQueryCost,
    queryCacheSize,
  }: {
    costThreshold: number;
    sampleRate: number;
    blockOnHighQueryCost: boolean;
    queryCacheSize: number;
  }
): ApolloServerPlugin {
  if (sampleRate < 0 || sampleRate > 1) {
    throw new Error(`Sample rate should be >= 0 && <= 1, got ${sampleRate}`);
  }
  if (sampleRate < 1 && blockOnHighQueryCost) {
    throw new Error(
      "Sample rate cannot be < 1 if blockOnHighQuery cost is enabled"
    );
  }
  const cachedCosts = new LruMap<string, number>(queryCacheSize);
  return {
    async requestDidStart() {
      return {
        async executionDidStart({ request, document }) {
          if (Math.random() > sampleRate) {
            return;
          }
          let cost: Maybe<number> = 0;
          try {
            cost = getCost(schema, document, request, cachedCosts);
          } catch (e) {
            emitter.emit("error", e as Error);
            return;
          }
          if (blockOnHighQueryCost && cost > costThreshold) {
            emitter.emit("blocked_request")
            throw new QueryCostTooHighError(cost, costThreshold);
          }
        },
      };
    },
  };
}
