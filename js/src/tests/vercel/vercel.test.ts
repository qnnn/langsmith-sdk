import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import {
  generateText,
  streamText,
  generateObject,
  streamObject,
  tool,
  LanguageModelV1StreamPart,
} from "ai";

import { z } from "zod";
import { AISDKExporter } from "../../vercel.js";
import { toArray } from "../utils.js";
import { mockClient } from "../utils/mock_client.js";
import { convertArrayToReadableStream } from "ai/test";
import { getAssumedTreeFromCalls } from "../utils/tree.js";
import { MockMultiStepLanguageModelV1, ExecutionOrderSame } from "./utils.js";

const { client, callSpy } = mockClient();
const exporter = new AISDKExporter({ client });
const provider = new NodeTracerProvider({
  spanProcessors: [new BatchSpanProcessor(exporter)],
});
provider.register();

const flush = async () => {
  // OTEL is weird and doesn't flush things properly all the time when you forceFlush
  await new Promise((resolve) => setTimeout(resolve, 100));
  await provider.forceFlush();
  await client.awaitPendingTraceBatches();
};

beforeEach(() => callSpy.mockClear());
afterAll(async () => await provider.shutdown());

test("generateText", async () => {
  const model = new MockMultiStepLanguageModelV1({
    doGenerate: async () => {
      if (model.generateStep === 0) {
        return {
          rawCall: { rawPrompt: null, rawSettings: {} },
          finishReason: "stop",
          usage: { promptTokens: 10, completionTokens: 20 },
          toolCalls: [
            {
              toolCallType: "function",
              toolName: "listOrders",
              toolCallId: "tool-id",
              args: JSON.stringify({ userId: "123" }),
            },
          ],
        };
      }

      return {
        rawCall: { rawPrompt: null, rawSettings: {} },
        finishReason: "stop",
        usage: { promptTokens: 10, completionTokens: 20 },
        text: `Hello, world!`,
      };
    },
  });

  await generateText({
    model,
    messages: [
      {
        role: "user",
        content: "What are my orders? My user ID is 123",
      },
    ],
    tools: {
      listOrders: tool({
        description: "list all orders",
        parameters: z.object({ userId: z.string() }),
        execute: async ({ userId }) =>
          `User ${userId} has the following orders: 1`,
      }),
    },
    experimental_telemetry: AISDKExporter.getSettings({
      isEnabled: true,
      runName: "generateText",
      functionId: "functionId",
      metadata: { userId: "123", language: "english" },
    }),
    maxSteps: 10,
  });

  await flush();
  expect(getAssumedTreeFromCalls(callSpy.mock.calls)).toMatchObject({
    nodes: [
      "generateText:0",
      "mock-provider:1",
      "listOrders:2",
      "mock-provider:3",
    ],
    edges: [
      ["generateText:0", "mock-provider:1"],
      ["generateText:0", "listOrders:2"],
      ["generateText:0", "mock-provider:3"],
    ],
    data: {
      "generateText:0": {
        name: "generateText",
        inputs: {
          messages: [
            {
              type: "human",
              data: { content: "What are my orders? My user ID is 123" },
            },
          ],
        },
        outputs: {
          llm_output: {
            type: "ai",
            data: { content: "Hello, world!" },
          },
        },
        extra: {
          metadata: {
            functionId: "functionId",
            userId: "123",
            language: "english",
            usage_metadata: {
              input_tokens: 10,
              output_tokens: 20,
              total_tokens: 30,
            },
          },
        },
        dotted_order: new ExecutionOrderSame(1, "000"),
      },
      "mock-provider:1": {
        inputs: {
          messages: [
            {
              type: "human",
              data: {
                content: [
                  {
                    type: "text",
                    text: "What are my orders? My user ID is 123",
                  },
                ],
              },
            },
          ],
        },
        outputs: {
          llm_output: {
            type: "ai",
            data: {
              content: [
                {
                  type: "tool_use",
                  name: "listOrders",
                  id: "tool-id",
                  input: { userId: "123" },
                },
              ],
              additional_kwargs: {
                tool_calls: [
                  {
                    id: "tool-id",
                    type: "function",
                    function: {
                      name: "listOrders",
                      id: "tool-id",
                      arguments: '{"userId":"123"}',
                    },
                  },
                ],
              },
            },
          },
        },
        extra: {
          metadata: {
            usage_metadata: {
              input_tokens: 10,
              output_tokens: 20,
              total_tokens: 30,
            },
          },
        },
        dotted_order: new ExecutionOrderSame(2, "000"),
      },
      "listOrders:2": {
        inputs: { userId: "123" },
        outputs: { output: "User 123 has the following orders: 1" },
        dotted_order: new ExecutionOrderSame(2, "001"),
      },
      "mock-provider:3": {
        inputs: {
          messages: [
            {
              type: "human",
              data: {
                content: [
                  {
                    type: "text",
                    text: "What are my orders? My user ID is 123",
                  },
                ],
              },
            },
            {
              type: "ai",
              data: {
                content: [
                  {
                    type: "tool_use",
                    name: "listOrders",
                    id: "tool-id",
                    input: { userId: "123" },
                  },
                ],
                additional_kwargs: {
                  tool_calls: [
                    {
                      id: "tool-id",
                      type: "function",
                      function: {
                        name: "listOrders",
                        id: "tool-id",
                        arguments: '{"userId":"123"}',
                      },
                    },
                  ],
                },
              },
            },
            {
              type: "tool",
              data: {
                content: '"User 123 has the following orders: 1"',
                name: "listOrders",
                tool_call_id: "tool-id",
              },
            },
          ],
        },
        outputs: {
          llm_output: {
            type: "ai",
            data: { content: "Hello, world!" },
          },
        },
        extra: {
          metadata: {
            usage_metadata: {
              input_tokens: 10,
              output_tokens: 20,
              total_tokens: 30,
            },
          },
        },
        dotted_order: new ExecutionOrderSame(2, "002"),
      },
    },
  });
});

test("streamText", async () => {
  const model = new MockMultiStepLanguageModelV1({
    doStream: async () => {
      if (model.streamStep === 0) {
        return {
          stream: convertArrayToReadableStream([
            {
              type: "tool-call",
              toolCallType: "function",
              toolName: "listOrders",
              toolCallId: "tool-id",
              args: JSON.stringify({ userId: "123" }),
            },
            {
              type: "finish",
              finishReason: "stop",
              logprobs: undefined,
              usage: { completionTokens: 10, promptTokens: 3 },
            },
          ] satisfies LanguageModelV1StreamPart[]),
          rawCall: { rawPrompt: null, rawSettings: {} },
        };
      }

      return {
        stream: convertArrayToReadableStream([
          { type: "text-delta", textDelta: "Hello" },
          { type: "text-delta", textDelta: ", " },
          { type: "text-delta", textDelta: `world!` },
          {
            type: "finish",
            finishReason: "stop",
            logprobs: undefined,
            usage: { completionTokens: 10, promptTokens: 3 },
          },
        ]),
        rawCall: { rawPrompt: null, rawSettings: {} },
      };
    },
  });

  const result = await streamText({
    model,
    messages: [
      {
        role: "user",
        content: "What are my orders? My user ID is 123",
      },
    ],
    tools: {
      listOrders: tool({
        description: "list all orders",
        parameters: z.object({ userId: z.string() }),
        execute: async ({ userId }) =>
          `User ${userId} has the following orders: 1`,
      }),
    },
    experimental_telemetry: AISDKExporter.getSettings({
      isEnabled: true,
      functionId: "functionId",
      metadata: { userId: "123", language: "english" },
    }),
    maxSteps: 10,
  });

  await toArray(result.fullStream);
  await flush();

  const actual = getAssumedTreeFromCalls(callSpy.mock.calls);
  expect(actual).toMatchObject({
    nodes: [
      "mock-provider:0",
      "mock-provider:1",
      "listOrders:2",
      "mock-provider:3",
    ],
    edges: [
      ["mock-provider:0", "mock-provider:1"],
      ["mock-provider:0", "listOrders:2"],
      ["mock-provider:0", "mock-provider:3"],
    ],
    data: {
      "mock-provider:0": {
        inputs: {
          messages: [
            {
              type: "human",
              data: { content: "What are my orders? My user ID is 123" },
            },
          ],
        },
        outputs: {
          llm_output: {
            type: "ai",
            data: { content: "Hello, world!" },
          },
        },
        extra: {
          metadata: {
            functionId: "functionId",
            userId: "123",
            language: "english",
            usage_metadata: {
              input_tokens: 6,
              output_tokens: 20,
              total_tokens: 26,
            },
          },
        },
        dotted_order: new ExecutionOrderSame(1, "000"),
      },
      "mock-provider:1": {
        inputs: {
          messages: [
            {
              type: "human",
              data: {
                content: [
                  {
                    type: "text",
                    text: "What are my orders? My user ID is 123",
                  },
                ],
              },
            },
          ],
        },
        outputs: {
          llm_output: {
            type: "ai",
            data: {
              content: [
                {
                  type: "tool_use",
                  name: "listOrders",
                  id: "tool-id",
                  input: { userId: "123" },
                },
              ],
              additional_kwargs: {
                tool_calls: [
                  {
                    id: "tool-id",
                    type: "function",
                    function: {
                      name: "listOrders",
                      id: "tool-id",
                      arguments: '{"userId":"123"}',
                    },
                  },
                ],
              },
            },
          },
        },
        extra: {
          metadata: {
            usage_metadata: {
              input_tokens: 3,
              output_tokens: 10,
              total_tokens: 13,
            },
          },
        },
        dotted_order: new ExecutionOrderSame(2, "000"),
      },
      "listOrders:2": {
        inputs: { userId: "123" },
        outputs: { output: "User 123 has the following orders: 1" },
        dotted_order: new ExecutionOrderSame(2, "001"),
      },
      "mock-provider:3": {
        inputs: {
          messages: [
            {
              type: "human",
              data: {
                content: [
                  {
                    type: "text",
                    text: "What are my orders? My user ID is 123",
                  },
                ],
              },
            },
            {
              type: "ai",
              data: {
                content: [
                  {
                    type: "tool_use",
                    name: "listOrders",
                    id: "tool-id",
                    input: { userId: "123" },
                  },
                ],
                additional_kwargs: {
                  tool_calls: [
                    {
                      id: "tool-id",
                      type: "function",
                      function: {
                        name: "listOrders",
                        id: "tool-id",
                        arguments: '{"userId":"123"}',
                      },
                    },
                  ],
                },
              },
            },
            {
              type: "tool",
              data: {
                content: '"User 123 has the following orders: 1"',
                name: "listOrders",
                tool_call_id: "tool-id",
              },
            },
          ],
        },
        outputs: {
          llm_output: {
            type: "ai",
            data: { content: "Hello, world!" },
          },
        },
        extra: {
          metadata: {
            usage_metadata: {
              input_tokens: 3,
              output_tokens: 10,
              total_tokens: 13,
            },
          },
        },
        dotted_order: new ExecutionOrderSame(2, "002"),
      },
    },
  });
});

test("generateObject", async () => {
  const model = new MockMultiStepLanguageModelV1({
    doGenerate: async () => ({
      rawCall: { rawPrompt: null, rawSettings: {} },
      finishReason: "stop",
      usage: { promptTokens: 10, completionTokens: 20 },
      toolCalls: [
        {
          toolCallType: "function",
          toolName: "json",
          toolCallId: "tool-id",
          args: JSON.stringify({
            weather: { city: "Prague", unit: "celsius" },
          }),
        },
      ],
    }),
    defaultObjectGenerationMode: "tool",
  });

  await generateObject({
    model,
    schema: z.object({
      weather: z.object({
        city: z.string(),
        unit: z.union([z.literal("celsius"), z.literal("fahrenheit")]),
      }),
    }),
    prompt: "What's the weather in Prague?",
    experimental_telemetry: AISDKExporter.getSettings({
      isEnabled: true,
      functionId: "functionId",
      metadata: { userId: "123", language: "english" },
    }),
  });

  await flush();
  const actual = getAssumedTreeFromCalls(callSpy.mock.calls);

  expect(actual).toMatchObject({
    nodes: ["mock-provider:0", "mock-provider:1"],
    edges: [["mock-provider:0", "mock-provider:1"]],
    data: {
      "mock-provider:0": {
        inputs: {
          input: { prompt: "What's the weather in Prague?" },
        },
        outputs: {
          output: { weather: { city: "Prague", unit: "celsius" } },
        },
        extra: {
          metadata: {
            usage_metadata: {
              input_tokens: 10,
              output_tokens: 20,
              total_tokens: 30,
            },
          },
        },
        dotted_order: new ExecutionOrderSame(1, "000"),
      },
      "mock-provider:1": {
        inputs: {
          messages: [
            {
              type: "human",
              data: {
                content: [
                  { type: "text", text: "What's the weather in Prague?" },
                ],
              },
            },
          ],
        },
        outputs: {
          output: { weather: { city: "Prague", unit: "celsius" } },
        },
        extra: {
          metadata: {
            functionId: "functionId",
            userId: "123",
            language: "english",
            usage_metadata: {
              input_tokens: 10,
              output_tokens: 20,
              total_tokens: 30,
            },
          },
        },
        dotted_order: new ExecutionOrderSame(2, "000"),
      },
    },
  });
});

test("streamObject", async () => {
  const model = new MockMultiStepLanguageModelV1({
    doGenerate: async () => ({
      rawCall: { rawPrompt: null, rawSettings: {} },
      finishReason: "stop",
      usage: { promptTokens: 10, completionTokens: 20 },
      toolCalls: [
        {
          toolCallType: "function",
          toolName: "json",
          toolCallId: "tool-id",
          args: JSON.stringify({
            weather: { city: "Prague", unit: "celsius" },
          }),
        },
      ],
    }),

    doStream: async () => {
      return {
        stream: convertArrayToReadableStream([
          {
            type: "tool-call-delta",
            toolCallType: "function",
            toolName: "json",
            toolCallId: "tool-id",
            argsTextDelta: JSON.stringify({
              weather: { city: "Prague", unit: "celsius" },
            }),
          },
          {
            type: "finish",
            finishReason: "stop",
            logprobs: undefined,
            usage: { completionTokens: 10, promptTokens: 3 },
          },
        ] satisfies LanguageModelV1StreamPart[]),
        rawCall: { rawPrompt: null, rawSettings: {} },
      };
    },
    defaultObjectGenerationMode: "tool",
  });

  const result = await streamObject({
    model,
    schema: z.object({
      weather: z.object({
        city: z.string(),
        unit: z.union([z.literal("celsius"), z.literal("fahrenheit")]),
      }),
    }),
    prompt: "What's the weather in Prague?",
    experimental_telemetry: AISDKExporter.getSettings({
      isEnabled: true,
      functionId: "functionId",
      metadata: { userId: "123", language: "english" },
    }),
  });

  await toArray(result.partialObjectStream);
  await flush();

  const actual = getAssumedTreeFromCalls(callSpy.mock.calls);
  expect(actual).toMatchObject({
    nodes: ["mock-provider:0", "mock-provider:1"],
    edges: [["mock-provider:0", "mock-provider:1"]],
    data: {
      "mock-provider:0": {
        inputs: {
          input: { prompt: "What's the weather in Prague?" },
        },
        outputs: {
          output: { weather: { city: "Prague", unit: "celsius" } },
        },
        extra: {
          metadata: {
            functionId: "functionId",
            userId: "123",
            language: "english",
            usage_metadata: {
              input_tokens: 3,
              output_tokens: 10,
              total_tokens: 13,
            },
          },
        },
        dotted_order: new ExecutionOrderSame(1, "000"),
      },
      "mock-provider:1": {
        inputs: {
          messages: [
            {
              type: "human",
              data: {
                content: [
                  { type: "text", text: "What's the weather in Prague?" },
                ],
              },
            },
          ],
        },
        outputs: {
          output: { weather: { city: "Prague", unit: "celsius" } },
        },
        extra: {
          metadata: {
            usage_metadata: {
              input_tokens: 3,
              output_tokens: 10,
              total_tokens: 13,
            },
          },
        },
        dotted_order: new ExecutionOrderSame(2, "000"),
      },
    },
  });
});
