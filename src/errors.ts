import type { components } from "./schema.ts";

export type ApiError = components["schemas"]["ApiError"];
export type ApiErrorEntry = components["schemas"]["ApiErrorEntry"];

const PROBLEM_MEDIA_TYPE = "application/problem+json";
/** The name the API files an error under when it names no request field. */
const GENERAL_ERRORS_FIELD = "generalErrors";

export function isProblem(response: Response): boolean {
  const mediaType = (response.headers.get("Content-Type") ?? "").split(";")[0] ?? "";
  return mediaType.trim().toLowerCase() === PROBLEM_MEDIA_TYPE;
}

function isApiError(body: unknown): body is ApiError {
  return (
    typeof body === "object" &&
    body !== null &&
    "code" in body &&
    typeof body.code === "string" &&
    "title" in body &&
    typeof body.title === "string" &&
    "status" in body &&
    typeof body.status === "number"
  );
}

/**
 * The detail, then each field error the detail does not already state. A refused command's detail
 * is only "One or more validation errors occurred", so the fields are what says what to change; a
 * single refusal's detail repeats its one entry, and a missing capability's names it in another case.
 */
function describe(problem: ApiError): string {
  const detail = problem.detail ?? "";
  const parts = detail ? [detail] : [];
  for (const entry of problem.errors ?? []) {
    if (entry.reason && !detail.toLowerCase().includes(entry.reason.toLowerCase())) {
      const named = entry.name && entry.name !== GENERAL_ERRORS_FIELD;
      parts.push(named ? `${entry.name}: ${entry.reason}` : entry.reason);
    }
  }
  return parts.join("; ") || problem.title;
}

/**
 * An error status from the API, thrown by every call once its retries are spent. `problem` is the
 * API's problem details when the response carried them; a response without them (a proxy's plain
 * 404 or 502) leaves it undefined and `code` empty.
 */
export class CostfluentError extends Error {
  override readonly name = "CostfluentError";
  readonly status: number;
  readonly problem: ApiError | undefined;
  /** The X-Request-Id to quote to support. */
  readonly requestId: string | undefined;

  constructor(status: number, problem?: ApiError, requestId?: string) {
    super(
      problem
        ? `Costfluent API answered ${status} ${problem.code}: ${describe(problem)}`
        : `Costfluent API answered ${status}`,
    );
    this.status = status;
    this.problem = problem;
    this.requestId = requestId;
  }

  static async fromResponse(response: Response): Promise<CostfluentError> {
    let problem: ApiError | undefined;
    if (isProblem(response)) {
      // A body that does not parse as problem details is reported as none, not as a second error.
      const body: unknown = await response.json().catch(() => undefined);
      problem = isApiError(body) ? body : undefined;
    }
    return new CostfluentError(response.status, problem, response.headers.get("X-Request-Id") ?? undefined);
  }

  /** The problem's snake_case code, such as `not_found` or `idempotency_key_reused`. */
  get code(): string {
    return this.problem?.code ?? "";
  }

  get fieldErrors(): ApiErrorEntry[] {
    return this.problem?.errors ?? [];
  }

  /** The API found no such object. A proxy's plain 404 says nothing about the object, so it is not one. */
  get isNotFound(): boolean {
    return this.status === 404 && this.problem !== undefined;
  }

  get isRateLimited(): boolean {
    return this.status === 429;
  }

  get isIdempotencyKeyReused(): boolean {
    return this.code === "idempotency_key_reused";
  }
}
