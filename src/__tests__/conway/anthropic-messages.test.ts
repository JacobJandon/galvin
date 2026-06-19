import { describe, it, expect } from "vitest";
import { transformMessagesForAnthropic, normalizeAnthropicMessages } from "../../conway/inference.js";

describe("normalizeAnthropicMessages — strict tool pairing + structure", () => {
  it("injects a tool_result when a tool_use is orphaned (context trimmed)", () => {
    const out = normalizeAnthropicMessages([
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "f", input: {} }] },
      { role: "user", content: "next thing" }, // missing tool_result for t1
    ]);
    // the message right after the tool_use must carry a tool_result for t1
    const afterAssistant = out[2] as { role: string; content: Array<{ type: string; tool_use_id?: string }> };
    expect(afterAssistant.role).toBe("user");
    expect(afterAssistant.content.some((b) => b.type === "tool_result" && b.tool_use_id === "t1")).toBe(true);
    expect(out[out.length - 1]!.role).toBe("user");
  });

  it("appends a tool_result when a tool_use is the LAST message", () => {
    const out = normalizeAnthropicMessages([
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "tool_use", id: "t9", name: "f", input: {} }] },
    ]);
    const last = out[out.length - 1] as { role: string; content: Array<{ type: string; tool_use_id?: string }> };
    expect(last.role).toBe("user");
    expect(last.content.some((b) => b.tool_use_id === "t9")).toBe(true);
  });

  it("drops an orphaned tool_result (no matching tool_use)", () => {
    const out = normalizeAnthropicMessages([
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "ghost", content: "x" }] },
    ]);
    // the orphaned tool_result message is dropped; nothing references "ghost"
    const json = JSON.stringify(out);
    expect(json).not.toContain("ghost");
    expect(out[out.length - 1]!.role).toBe("user");
  });

  it("first message ends up a user message", () => {
    const out = normalizeAnthropicMessages([
      { role: "assistant", content: [{ type: "text", text: "leading" }] },
      { role: "user", content: "prompt" },
    ]);
    expect(out[0]!.role).toBe("user");
  });
});

describe("transformMessagesForAnthropic — Anthropic message-shape rules", () => {
  it("appends a user turn when the conversation ends on an assistant message (no prefill)", () => {
    const { messages } = transformMessagesForAnthropic([
      { role: "user", content: "hi" },
      { role: "assistant", content: "thinking..." },
    ]);
    expect(messages[messages.length - 1]!.role).toBe("user");
  });

  it("does not touch a conversation that already ends with a user message", () => {
    const { messages } = transformMessagesForAnthropic([
      { role: "assistant", content: "prev" },
      { role: "user", content: "now do X" },
    ]);
    expect(messages[messages.length - 1]!.role).toBe("user");
    expect((messages[messages.length - 1]! as { content: string }).content).toBe("now do X");
  });

  it("drops leading assistant messages so the first turn is a user message", () => {
    const { messages } = transformMessagesForAnthropic([
      { role: "assistant", content: "leading prefill" },
      { role: "user", content: "real prompt" },
    ]);
    expect(messages[0]!.role).toBe("user");
  });

  it("extracts system messages and keeps a valid user/assistant body", () => {
    const { system, messages } = transformMessagesForAnthropic([
      { role: "system", content: "you are Galvin" },
      { role: "user", content: "earn money" },
    ]);
    expect(system).toContain("you are Galvin");
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe("user");
  });

  it("a tool result becomes a user message → conversation ends on user", () => {
    const { messages } = transformMessagesForAnthropic([
      { role: "user", content: "do it" },
      { role: "assistant", content: "", tool_calls: [{ id: "t1", type: "function", function: { name: "f", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "t1", content: "result" },
    ]);
    expect(messages[messages.length - 1]!.role).toBe("user");
  });
});
