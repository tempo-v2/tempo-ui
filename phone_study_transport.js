import { JsonHttpError } from "./content_transport.js";
import { studyTransport } from "./study_transport.js";

const unreachable = "Could not reach Tempo. Check Tailscale and make sure your MacBook is awake, then retry.";

// The phone adds connection guidance without replacing Study delivery or recovery.
export const phoneStudyTransport = {
  async send(command) {
    try {
      return await studyTransport.send(command);
    } catch (error) {
      if (error instanceof JsonHttpError && !error.details && [502, 503, 504].includes(error.status))
        throw new JsonHttpError(error.status, undefined, unreachable);
      if (error instanceof TypeError || error.name === "TimeoutError") {
        const issue = new Error(unreachable, { cause: error });
        issue.name = error.name;
        throw issue;
      }
      throw error;
    }
  },
};
