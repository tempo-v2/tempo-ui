import { SHORT_ACK_TIMEOUT_MS, SMALL_READ_TIMEOUT_MS } from "./bounded_read.js";
import { postCommand, studyMoveDetails } from "./content_transport.js";
import { signalStudyChange } from "./study_presence.js";

export const studyTransport = {
  async send(command) {
    // All other Study commands can change the active attempt or durable state.
    const statusRead = command.command === "study_status";
    if (!statusRead) signalStudyChange();
    const reply = await postCommand("/api/study", command, undefined, studyMoveDetails, {
      timeoutMs: statusRead ? SMALL_READ_TIMEOUT_MS : SHORT_ACK_TIMEOUT_MS,
    });
    if (!statusRead) signalStudyChange();
    return reply;
  },
};
