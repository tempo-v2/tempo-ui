import { commandRecovery } from "./content_transport.js";

const recovery = commandRecovery("tempo-repertoire-recovery-v4",
  ({ command, token, dataset_id, repertoire_id }) => ({ command, token, dataset_id, repertoire_id }));

export const pendingRepertoireEntry = recovery.entry;
export const hasPendingRepertoireCommand = recovery.hasPending;
export const readPendingRepertoireCommand = recovery.load;
export const savePendingRepertoireCommand = recovery.save;
