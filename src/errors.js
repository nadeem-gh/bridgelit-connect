// Errors a job can end with; their messages are shown to the user in BridgeLit.
export class ProviderError extends Error {}

/** The model tried to use a tool: the run is stopped and its answer thrown away. */
export class ToolAttempt extends ProviderError {}
