// Tunable relay limits. All values are optional; every reader falls back to
// its own default when unset. Override via CH_* environment variables.

export interface LimitsSpec {
  cutChars?: number;
  maxSegments?: number;
  tailChars?: number;
  postcallChars?: number;
  postcallStallMs?: number;
  upstreamHdrMs?: number;
  noFirstByteMs?: number;
  callOpenMaxMs?: number;
  digestChars?: number;
  contEffort?: string;
  mainEffort?: string;
  stripReasoning?: string;
  holdback?: number;
  argHoldback?: number;
  lightChars?: number;
  lightModel?: string;
  lightCollab?: boolean;
  subagentModel?: string;
  reviewModel?: string;
  trimChars?: number;
  jsonLane?: boolean;
  slim?: boolean;
}

export const POLICY: { limits: LimitsSpec } = {
  limits: {},
};
