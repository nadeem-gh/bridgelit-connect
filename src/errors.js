// Errors a job can end with; their messages are shown to the user in BridgeLit.
export class ProviderError extends Error {}

/** The model tried to use a tool: the run is stopped and its answer thrown away. */
export class ToolAttempt extends ProviderError {}

/**
 * The provider asked us to slow down (HTTP 429). ``retryAfter`` is in seconds.
 * The job is not failed: it is retried here, or handed back to BridgeLit for later.
 */
export class RateLimited extends ProviderError {
  constructor(message, retryAfter) {
    super(message);
    this.retryAfter = retryAfter;
  }
}
