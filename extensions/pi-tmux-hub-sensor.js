import { writeRegistryEntry } from '../src/hub.js';

export default function piTmuxHubSensor(pi) {
  async function publish(ctx, state, details = {}) {
    if (!process.env.TMUX_PANE) return;
    try {
      await writeRegistryEntry({
        cwd: ctx?.cwd || process.cwd(),
        last: details.last,
        lastToolName: details.lastToolName,
        paneId: process.env.TMUX_PANE,
        pid: process.pid,
        sessionFile: ctx?.sessionManager?.getSessionFile?.(),
        state,
      });
    } catch {
      // Sensor only: never break the Pi session if telemetry cannot be written.
    }
  }

  pi.on('session_start', async (_event, ctx) => publish(ctx, 'waiting', { last: 'session_start' }));
  pi.on('agent_start', async (_event, ctx) => publish(ctx, 'working', { last: 'agent_start' }));
  pi.on('turn_start', async (_event, ctx) => publish(ctx, 'working', { last: 'turn_start' }));
  pi.on('tool_call', async (event, ctx) => publish(ctx, 'working', { last: 'tool_call', lastToolName: event.toolName }));
  pi.on('tool_result', async (event, ctx) => publish(ctx, 'working', { last: 'tool_result', lastToolName: event.toolName }));
  pi.on('agent_end', async (event, ctx) => {
    const stopReason = lastAssistantStopReason(event?.messages);
    await publish(ctx, stopReason === 'error' ? 'error' : 'waiting', { last: stopReason || 'agent_end' });
  });
  pi.on('session_shutdown', async (_event, ctx) => publish(ctx, 'stopped', { last: 'session_shutdown' }));
}

function lastAssistantStopReason(messages = []) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'assistant') return message.stopReason;
  }
  return undefined;
}
