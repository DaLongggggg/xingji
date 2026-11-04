import { ZodError } from "zod";

type ErrorCode =
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "DESTINATION_BUILDING"
  | "RATE_LIMITED"
  | "PROVIDER_UNAVAILABLE"
  | "INTERNAL_ERROR";

export function apiSuccess<T>(data: T, init?: ResponseInit): Response {
  return Response.json(
    { data, meta: { requestId: crypto.randomUUID() } },
    { status: 200, ...init }
  );
}

export function apiError(
  code: ErrorCode,
  message: string,
  status: number,
  fields?: Record<string, string>
): Response {
  return Response.json(
    {
      error: {
        code,
        message,
        ...(fields ? { fields } : {}),
        requestId: crypto.randomUUID()
      }
    },
    { status }
  );
}

export function validationError(error: ZodError): Response {
  const fields = Object.fromEntries(
    error.issues.map((issue) => [issue.path.join(".") || "request", issue.message])
  );
  return apiError("VALIDATION_ERROR", "请求参数不正确", 400, fields);
}

/** 限制 JSON 请求体，避免本地演示接口接收无界输入。 */
export async function readJsonBody(request: Request, maxBytes = 64 * 1024): Promise<unknown> {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > maxBytes) {
    throw new Error("REQUEST_TOO_LARGE");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new Error("REQUEST_TOO_LARGE");
  }
  return JSON.parse(text);
}
