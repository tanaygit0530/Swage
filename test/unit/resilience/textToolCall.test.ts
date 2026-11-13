import { describe, expect, it } from 'vitest';
import { AGENT_TOOL_NAMES, textToolCalls } from '../../../src/resilience/textToolCall';

describe('tool calls written as text', () => {
  it('finds tool calls a model wrote out instead of calling them', () => {
    // As Ollama Qwen 7B answered through TrueForge in the rehearsal.
    expect(
      textToolCalls(
        '{"name": "find_relevant_code", "arguments": {"query": "flask config command", "limit": 5}}',
        AGENT_TOOL_NAMES,
      ),
    ).toEqual(['find_relevant_code']);
    expect(
      textToolCalls(
        'Sure. ```json\n{"tool": "stage_edit", "parameters": {"path": "a.py"}}\n```',
        AGENT_TOOL_NAMES,
      ),
    ).toEqual(['stage_edit']);
  });

  it('ignores ordinary text and JSON that is not one of our tools', () => {
    expect(textToolCalls('Done: the docstring now lists every value.', AGENT_TOOL_NAMES)).toEqual(
      [],
    );
    expect(textToolCalls('{"name": "requests", "arguments": {}}', AGENT_TOOL_NAMES)).toEqual([]);
  });
});
