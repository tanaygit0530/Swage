import type { ToolEvents } from '../mcp/context';

/**
 * The MCP server's tool events go to whichever agent run is active. The server is created
 * once with this relay; each run attaches itself while it runs.
 */
export class EventRelay implements ToolEvents {
  private target: ToolEvents | undefined;

  attach(target: ToolEvents): { dispose(): void } {
    this.target = target;
    return {
      dispose: () => {
        if (this.target === target) this.target = undefined;
      },
    };
  }

  onDeclare(
    taskId: string,
    plan: readonly string[],
    files: readonly { path: string; reason: string }[],
  ): void {
    this.target?.onDeclare?.(taskId, plan, files);
  }

  onStage(taskId: string, path: string): void {
    this.target?.onStage?.(taskId, path);
  }

  onSubmit(taskId: string, summary: string): void {
    this.target?.onSubmit?.(taskId, summary);
  }

  onCommand(taskId: string, command: string, outcome: string): void {
    this.target?.onCommand?.(taskId, command, outcome);
  }
}
