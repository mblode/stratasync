/**
 * Error code returned to clients whose sync cursor has fallen behind the
 * earliest retained sync action and must re-bootstrap.
 */
export const BOOTSTRAP_REQUIRED = "BOOTSTRAP_REQUIRED";

/**
 * The two channel-specific BOOTSTRAP_REQUIRED message strings. They differ on
 * the wire and MUST stay different: HTTP clients are fetching deltas, WS
 * clients are subscribing to deltas.
 */
export const BOOTSTRAP_REQUIRED_HTTP_MESSAGE =
  "A fresh bootstrap is required before fetching deltas";

export const BOOTSTRAP_REQUIRED_WS_MESSAGE =
  "A fresh bootstrap is required before subscribing to deltas";
