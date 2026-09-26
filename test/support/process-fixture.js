import { superviseProcess } from "../../src/process-utils.ts";

/** Establish death normally, then inject the cleanup error under test. */
export function supervisorWithCleanupFailure(message) {
  return (child, options) => {
    const supervisor = superviseProcess(child, options);
    let termination;
    return {
      ...supervisor,
      terminate() {
        termination ??= supervisor.terminate().then(() => { throw new Error(message); });
        return termination;
      },
    };
  };
}
