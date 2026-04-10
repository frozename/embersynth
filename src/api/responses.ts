import type {
  ResponsesRequest,
  ResponsesResponse,
  ResponsesOutputItem,
  ChatCompletionRequest,
  ChatMessage,
  EmberSynthConfig,
} from '../types/index.js';
import type { NodeRegistry } from '../registry/registry.js';
import type { TraceContext } from '../tracing/context.js';
import { route, routeStreaming } from '../router/index.js';

function generateId(): string {
  return `resp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function generateMsgId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Convert Responses API input to chat messages */
function toMessages(request: ResponsesRequest): ChatMessage[] {
  const messages: ChatMessage[] = [];

  if (request.instructions) {
    messages.push({ role: 'system', content: request.instructions });
  }

  if (typeof request.input === 'string') {
    messages.push({ role: 'user', content: request.input });
  } else {
    for (const msg of request.input) {
      messages.push({
        role: msg.role,
        content: msg.content,
      });
    }
  }

  return messages;
}

export async function handleResponses(
  req: Request,
  config: EmberSynthConfig,
  registry: NodeRegistry,
  traceCtx?: TraceContext,
): Promise<Response> {
  let body: ResponsesRequest;

  try {
    body = (await req.json()) as ResponsesRequest;
  } catch {
    return Response.json(
      { error: { message: 'Invalid JSON body', type: 'invalid_request_error' } },
      { status: 400 },
    );
  }

  if (!body.model) {
    return Response.json(
      { error: { message: 'Missing required field: model', type: 'invalid_request_error' } },
      { status: 400 },
    );
  }

  if (!body.input) {
    return Response.json(
      { error: { message: 'Missing required field: input', type: 'invalid_request_error' } },
      { status: 400 },
    );
  }

  const messages = toMessages(body);

  // Streaming responses API
  if (body.stream) {
    const chatReq: ChatCompletionRequest = {
      model: body.model,
      messages,
      temperature: body.temperature,
      max_tokens: body.max_output_tokens,
      tools: body.tools,
      tool_choice: body.tool_choice,
      stream: true,
    };

    const result = await routeStreaming(chatReq, config, registry, traceCtx);

    if (!result.ok) {
      return Response.json(
        { error: { message: result.error.message, type: 'api_error' } },
        { status: result.error.status },
      );
    }

    // Wrap the chat completion stream in Responses API streaming events
    const responseId = generateId();
    const msgId = generateMsgId();
    const created = Math.floor(Date.now() / 1000);
    const encoder = new TextEncoder();

    const transformedStream = new ReadableStream<Uint8Array>({
      async start(controller) {
        // Send response.created event
        controller.enqueue(encoder.encode(
          `event: response.created\ndata: ${JSON.stringify({ id: responseId, object: 'response', created_at: created, model: body.model, output: [] })}\n\n`
        ));

        // Send output_item.added
        controller.enqueue(encoder.encode(
          `event: response.output_item.added\ndata: ${JSON.stringify({ type: 'message', id: msgId, role: 'assistant', content: [] })}\n\n`
        ));

        // Read the underlying SSE stream and re-emit as Responses events
        const reader = result.result.stream.getReader();
        const decoder = new TextDecoder();
        let fullContent = '';
        let sseBuffer = '';

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            sseBuffer += decoder.decode(value, { stream: true });
            const lines = sseBuffer.split('\n');
            sseBuffer = lines.pop() ?? ''; // keep incomplete line in buffer

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed.startsWith('data: ') || trimmed === 'data: [DONE]') continue;
              try {
                const chunk = JSON.parse(trimmed.slice(6));
                const delta = chunk.choices?.[0]?.delta?.content;
                if (delta) {
                  fullContent += delta;
                  controller.enqueue(encoder.encode(
                    `event: response.output_text.delta\ndata: ${JSON.stringify({ delta })}\n\n`
                  ));
                }
              } catch { /* skip malformed chunks */ }
            }
          }

          // Send completion events
          controller.enqueue(encoder.encode(
            `event: response.output_text.done\ndata: ${JSON.stringify({ text: fullContent })}\n\n`
          ));
          controller.enqueue(encoder.encode(
            `event: response.completed\ndata: ${JSON.stringify({
              id: responseId, object: 'response', created_at: created, model: body.model,
              output: [{ type: 'message', id: msgId, role: 'assistant', content: [{ type: 'output_text', text: fullContent }] }],
            })}\n\n`
          ));
          controller.close();
        } catch (err) {
          controller.error(err);
        } finally {
          reader.releaseLock();
        }
      },
    });

    return new Response(transformedStream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  }

  // Non-streaming
  const chatReq: ChatCompletionRequest = {
    model: body.model,
    messages,
    temperature: body.temperature,
    max_tokens: body.max_output_tokens,
    tools: body.tools,
    tool_choice: body.tool_choice,
    stream: false,
  };

  const result = await route(chatReq, config, registry, traceCtx);

  if (!result.ok) {
    return Response.json(
      { error: { message: result.error.message, type: 'api_error' } },
      { status: result.error.status },
    );
  }

  const output: ResponsesOutputItem = {
    type: 'message',
    id: generateMsgId(),
    role: 'assistant',
    content: [{ type: 'output_text', text: result.result.response.content }],
  };

  const usage = result.result.response.usage;

  const response: ResponsesResponse = {
    id: generateId(),
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    model: body.model,
    output: [output],
    usage: usage
      ? {
          input_tokens: usage.promptTokens,
          output_tokens: usage.completionTokens,
          total_tokens: usage.totalTokens,
        }
      : undefined,
  };

  return Response.json(response);
}
