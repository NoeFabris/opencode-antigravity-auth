import { expect, test, describe } from "vitest";
import { prepareAntigravityRequest } from "./request";

type RequestBody = Record<string, unknown>;

function buildAntigravityRequest(
  model: string,
  body: RequestBody,
  action = "generateContent",
) {
  const init = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  } as RequestInit;

  const prepared = prepareAntigravityRequest(
    `https://generativelanguage.googleapis.com/v1/models/${model}:${action}`,
    init,
    "token",
    "test-project",
  );

  if (typeof prepared.init.body !== "string") {
    throw new Error("expected Antigravity request body to be string");
  }

  const parsed = JSON.parse(prepared.init.body) as Record<string, unknown>;
  const requestPayload = parsed.request as Record<string, unknown>;

  if (!requestPayload.tools || !Array.isArray(requestPayload.tools)) {
    throw new Error("tools payload missing");
  }

  return {
    prepared,
    requestPayload,
    parsedBody: parsed,
  };
}

describe("prepareAntigravityRequest tool normalization", () => {
  test("preserves Claude tool schemas that reference anyOf/allOf/oneOf", () => {
    const complexSchema = {
      type: "object",
      properties: {
        primary: { type: "string" },
      },
      anyOf: [{ properties: { branch: { type: "string" } } }],
      allOf: [{ properties: { union: { type: "string" } } }],
      oneOf: [{ properties: { exclusive: { type: "string" } } }],
    };

    const payload: RequestBody = {
      contents: [],
      tools: [
        {
          functionDeclarations: [
            {
              name: "complex-tool",
              description: "needs ordering",
              parameters: complexSchema,
            },
          ],
        },
      ],
    };

    const { requestPayload } = buildAntigravityRequest("claude-3.5", payload, "streamGenerateContent");
    const tools = requestPayload.tools as Record<string, unknown>[];
    const functionDecls = tools[0]?.functionDeclarations as Record<string, unknown>[] | undefined;
    const params = functionDecls?.[0]?.parameters as Record<string, unknown>;

    expect(params?.anyOf).toEqual(complexSchema.anyOf);
    expect(params?.allOf).toEqual(complexSchema.allOf);
    expect(params?.oneOf).toEqual(complexSchema.oneOf);
    expect(params?.properties).toEqual(complexSchema.properties);
  });

  test("normalizes Claude tools without schemas into void schema", () => {
    const payload: RequestBody = {
      contents: [],
      tools: [
        {
          name: "void-tool",
          function: {
            name: "void-tool",
            description: "no schema here",
          },
        },
      ],
    };

    const { requestPayload } = buildAntigravityRequest("claude-3.5", payload);
    const tools = requestPayload.tools as Record<string, unknown>[];
    const functionDecls = tools[0]?.functionDeclarations as Record<string, unknown>[] | undefined;
    const params = functionDecls?.[0]?.parameters;

    expect(params).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
  });

  test("runs Gemini/standard normalization path for non-Claude models", () => {
    const schema = {
      type: "object",
      properties: {
        query: { type: "string" },
      },
    };

    const payload: RequestBody = {
      contents: [],
      tools: [
        {
          name: "gemini-tool",
          description: "custom wrapper",
          function: {
            name: "gemini-tool",
            description: "function style",
          },
          custom: {
            name: "gemini-tool",
            description: "custom style",
            input_schema: schema,
          },
        },
      ],
    };

    const { requestPayload } = buildAntigravityRequest("gemini-2.0", payload);
    const tools = requestPayload.tools as Record<string, unknown>[] | undefined;
    const normalized = tools?.[0] as Record<string, unknown> | undefined;

    expect(normalized?.custom).toBeUndefined();
    expect(normalized?.function).toBeDefined();
    expect((normalized?.function as Record<string, unknown>)?.input_schema).toEqual(schema);
  });

  test("does not mutate supplied tool definitions during normalization", () => {
    const sharedSchema = {
      type: "object",
      properties: {
        kept: { type: "string" },
      },
    } as const;

    const toolDefinition = {
      name: "clone-tool",
      function: {
        name: "clone-tool",
        description: "preserve me",
        parameters: sharedSchema,
      },
    };

    const originalSnapshot = structuredClone(toolDefinition);
    const payload: RequestBody = {
      contents: [],
      tools: [toolDefinition],
    };

    const { requestPayload } = buildAntigravityRequest("claude-3.5", payload);

    expect(toolDefinition).toEqual(originalSnapshot);

    const tools = requestPayload.tools as Record<string, unknown>[] | undefined;
    const functionDecls = tools?.[0]?.functionDeclarations as Record<string, unknown>[] | undefined;
    const normalizedSchema = functionDecls?.[0]?.parameters as Record<string, unknown> | undefined;
    expect(normalizedSchema?.properties).toEqual(sharedSchema.properties);
  });
});
