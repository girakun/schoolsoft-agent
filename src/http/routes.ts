/**
 * The REST routes, generated from the operation registry: one GET route per operation
 * the connector offers, with query parameters derived from the operation's Zod input.
 * Pure (no Express), so the router, the docs generator and the tests share one table.
 */
import { z } from "zod";
import { InputError, describeIssues, operations, type Operation } from "../core/index.js";
/** REST retains its existing typed contract; MCP exposes all read-only operations. */
export const REST_OPERATIONS = [
  "list_children",
  "get_schedule",
  "get_calendar",
  "get_lunch_menu",
] as const;

export const API_BASE = "/api/v1";
/** The path segment that names a child; its value is the id `list_children` returns. */
const CHILD = "childId";

export interface QueryParam {
  name: string;
  kind: "number" | "boolean" | "string";
  description: string;
}
/** What a query string may contain: its parameters and the strict schema they must fit. */
export interface QueryShape {
  query: QueryParam[];
  /** The input minus `child_id`, strict: what the query string may contain. */
  schema: z.ZodObject;
}
export interface RestRoute extends QueryShape {
  operation: Operation;
  /** Express pattern below API_BASE, e.g. `/children/:childId/schedule`. */
  pattern: string;
  /** The documented form, e.g. `/api/v1/children/{childId}/schedule`. */
  path: string;
  /** Whether the child comes from the path (the operation takes `child_id`). */
  childScoped: boolean;
}

/**
 * Child routes that are not generated from one operation (the overview). A generated
 * route may not take their slug, so an operation can never shadow one.
 */
export const COMPOSITE_SLUGS: readonly string[] = ["overview"];

/** `get_lunch_menu` → `lunch-menu`, `list_children` → `children`. */
export function slug(name: string): string {
  return name.replace(/^(get|list)_/, "").replaceAll("_", "-");
}

function queryParam(name: string, raw: z.core.$ZodType): QueryParam {
  const schema = raw as z.ZodType;
  const inner = schema instanceof z.ZodOptional ? (schema.unwrap() as z.ZodType) : schema;
  const description = schema.description ?? inner.description ?? "";
  if (inner instanceof z.ZodNumber) return { name, kind: "number", description };
  if (inner instanceof z.ZodBoolean) return { name, kind: "boolean", description };
  if (inner instanceof z.ZodString) return { name, kind: "string", description };
  throw new Error(`REST: unsupported input schema for "${name}"`);
}

/** The query parameters and strict schema for a Zod input shape (without `child_id`). */
export function queryShape(input: z.ZodRawShape): QueryShape {
  return {
    query: Object.entries(input).map(([name, schema]) => queryParam(name, schema)),
    schema: z.object(input).strict(),
  };
}

/**
 * One route per offered operation, in registry order. Only read-only operations with
 * a declared output can be offered: the REST response is that validated output.
 */
export function restRoutes(
  registry: readonly Operation[] = operations,
  offered: readonly string[] = REST_OPERATIONS,
): RestRoute[] {
  return registry
    .filter((operation) => offered.includes(operation.name))
    .map((operation) => {
      if (!operation.annotations.readOnly || !operation.output)
        throw new Error(`REST: ${operation.name} must be read-only and typed`);
      const { child_id, ...rest } = operation.input;
      const childScoped = child_id !== undefined;
      if (COMPOSITE_SLUGS.includes(slug(operation.name)))
        throw new Error(`REST: ${operation.name} would shadow a composite route`);
      const pattern = childScoped
        ? `/children/:${CHILD}/${slug(operation.name)}`
        : `/${slug(operation.name)}`;
      return {
        operation,
        pattern,
        path: API_BASE + pattern.replace(`:${CHILD}`, `{${CHILD}}`),
        childScoped,
        ...queryShape(rest),
      };
    });
}

/** A child id from the path: a positive integer, as `list_children` returns it. */
export function parseChildId(value: string): number {
  const id = /^[1-9][0-9]{0,15}$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(id)) throw new InputError(`${CHILD} must be a positive integer`);
  return id;
}

/**
 * Query string → operation arguments. Each parameter at most once, converted by its
 * declared kind, then checked against the operation's own schema (unknown keys refused).
 */
export function parseQuery(
  route: QueryShape,
  query: Record<string, unknown>,
): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(query)) {
    const param = route.query.find((candidate) => candidate.name === name);
    if (!param) throw new InputError(`unknown query parameter "${name}"`);
    if (typeof value !== "string") throw new InputError(`"${name}" may be given once`);
    if (param.kind === "number") {
      if (!/^-?[0-9]+(\.[0-9]+)?$/.test(value)) throw new InputError(`${name} must be a number`);
      args[name] = Number(value);
    } else if (param.kind === "boolean") {
      if (value !== "true" && value !== "false")
        throw new InputError(`${name} must be true or false`);
      args[name] = value === "true";
    } else args[name] = value;
  }
  const parsed = route.schema.safeParse(args);
  if (!parsed.success) throw new InputError(describeIssues(parsed.error.issues));
  return parsed.data;
}
