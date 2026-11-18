import { useState } from "react";
import type { MachineInfo, SessionInfo } from "@gasho/protocol";
import { hibernationNote } from "@/lib/sessions";
import { sendCommand } from "@/lib/store";

/**
 * Above the chat box of a hibernated session: that it is asleep, that it is coming back, or why it could not, with a
 * button to try again. What was sent to it stays on the working server meanwhile.
 */
export function HibernationNotice({ machine, session: s }: { machine: MachineInfo; session: SessionInfo }) {
  const [error, setError] = useState<string>();
  const [asking, setAsking] = useState(false);
  const note = hibernationNote(s);
  if (!note || !machine.connected) return null;
  const failed = s.hibernation === "hibernated" && s.resumeError !== undefined;

  const wake = async () => {
    setAsking(true);
    setError(undefined);
    try {
      const r = await sendCommand(machine.id, { type: "session.wake", sessionId: s.sessionId });
      if (!r.ok) setError(r.error);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAsking(false);
    }
  };

  return (
    <div role={failed ? "alert" : "status"} className="mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 px-3 text-xs">
      <p className={failed ? "min-w-0 flex-1 text-red-400" : "min-w-0 flex-1 text-muted-foreground"}>{error ?? note}</p>
      {failed && (
        <button
          type="button"
          disabled={asking}
          onClick={() => void wake()}
          className="shrink-0 rounded-md bg-white/[0.08] px-2 py-1 font-medium text-foreground transition-colors hover:bg-white/[0.14] disabled:opacity-50"
        >
          もう一度再開
        </button>
      )}
    </div>
  );
}
