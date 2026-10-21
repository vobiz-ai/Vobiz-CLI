/**
 * Reference tables for `vobiz diagnose`, transcribed from the Vobiz docs. Nothing here is inferred: a code or
 * cause that is not in these tables is reported as undocumented with a link to the docs page.
 *
 *   HANGUP_CODES, SIP_HANGUP_CAUSES, HANGUP_SOURCES   concepts/hangup-causes.mdx (and cdr.mdx "Hangup Causes")
 *   SIP_RESPONSES                                     faq/sip-codes-480-486.mdx
 *   QUALITY                                           cdr.mdx "Diagnose a hangup_cause" (MOS, jitter, packet loss)
 *   MESSAGE_STATUSES                                  openapi-sms.yaml Message.status and the vobiz-sms skill
 */
export const DOCS = {
  hangupCauses: "https://www.vobiz.ai/docs/concepts/hangup-causes",
  cdr: "https://www.vobiz.ai/docs/cdr",
  sip480486: "https://www.vobiz.ai/docs/faq/sip-codes-480-486",
  streamEvents: "https://www.vobiz.ai/docs/xml/stream/stream-events",
  smsMessages: "https://www.vobiz.ai/docs/sms/api/messages",
  smsErrors: "https://www.vobiz.ai/docs/sms/errors",
  smsWebhooks: "https://www.vobiz.ai/docs/sms/webhooks",
} as const;

export interface HangupCode {
  group: string;
  cause: string;
  description: string;
  nextSteps: string;
}

/** Numeric hangup codes (`hangup_cause_code`, `HangupCauseCode`). */
export const HANGUP_CODES: Record<number, HangupCode> = {
  4000: { group: "Normal completion", cause: "Normal Hangup", description: "Call terminated normally", nextSteps: "None. Call completed successfully" },
  4010: { group: "Normal completion", cause: "End Of XML Instructions", description: "No more XML instructions to execute", nextSteps: "None. Normal for XML-controlled calls" },
  4020: { group: "Normal completion", cause: "Multiparty Call Ended", description: "MPC ended via API or max duration", nextSteps: "None. Check if max duration was intentional" },
  4030: { group: "Normal completion", cause: "Kicked Out Of Multiparty Call", description: "Participant removed via API", nextSteps: "None. Verify participant removal was expected" },
  0: { group: "Canceled", cause: "Unknown", description: "Hangup reason undetermined. Known bug: the Delete All Calls API sets this", nextSteps: "Check call logs for context" },
  1000: { group: "Canceled", cause: "Canceled", description: "Call canceled via Hangup Call API before answer", nextSteps: "None. Intentional cancellation" },
  1010: { group: "Canceled", cause: "Canceled (Out Of Credits)", description: "Account ran out of credits", nextSteps: "Add credits. Enable auto-recharge in Console → Billing" },
  1020: { group: "Canceled", cause: "Canceled (Simultaneous dial limit reached)", description: "Simultaneous dial limit exceeded", nextSteps: "Reduce concurrent dials to the same destination" },
  2000: { group: "Destination issue", cause: "Invalid Destination Address", description: "Destination number/endpoint invalid", nextSteps: "Use E.164 format (+12292442099). Verify the number is valid" },
  2010: { group: "Destination issue", cause: "Destination Out Of Service", description: "Destination unavailable", nextSteps: "Retry later. Verify the destination is active" },
  2020: { group: "Destination issue", cause: "Endpoint Not Registered", description: "SIP endpoint unregistered or unreachable", nextSteps: "Verify the endpoint is logged in. Check SDK troubleshooting" },
  2030: { group: "Destination issue", cause: "Destination Country Barred", description: "Country disabled in geo permissions", nextSteps: "Enable the country in Console → Voice → Geo Permissions" },
  2040: { group: "Destination issue", cause: "Destination Number Barred", description: "Premium rate numbers disabled", nextSteps: "Enable high-risk permissions in Console → Voice → Geo Permissions" },
  2050: { group: "Destination issue", cause: "Destination Prefix Barred", description: "Prefix not permitted", nextSteps: "Enable the prefix in Console → Voice → Geo Permissions" },
  2060: { group: "Destination issue", cause: "Loop Detected", description: "B-leg would redial the A-leg's number", nextSteps: "Fix routing logic to prevent loops" },
  2070: { group: "Destination issue", cause: "Violates Media Anchoring", description: "India PSTN regulation violation", nextSteps: "For India calls, your server must be in India. Don't mix PSTN and WebRTC in conferences" },
  3000: { group: "Call rejection", cause: "No Answer", description: "Destination unavailable or unreachable", nextSteps: "Retry. Check if the destination is online" },
  3010: { group: "Call rejection", cause: "Busy Line", description: "Destination is busy", nextSteps: "Retry later or implement voicemail fallback" },
  3020: { group: "Call rejection", cause: "Rejected", description: "Call rejected by the called party", nextSteps: "None. Recipient declined the call" },
  3030: { group: "Call rejection", cause: "Unknown Caller ID", description: "Non-Vobiz number used as caller ID", nextSteps: "Use a Vobiz-rented number as caller ID" },
  3040: { group: "Call rejection", cause: "Forbidden", description: "Destination rejected or blocked the call", nextSteps: "Have the recipient check for blocked numbers" },
  3050: { group: "Call rejection", cause: "Unallocated number", description: "Destination invalid or out of service", nextSteps: "Verify the destination number accuracy" },
  3070: { group: "Carrier error", cause: "Request timeout", description: "Carrier didn't respond in time", nextSteps: "Retry. Check carrier availability" },
  3080: { group: "Carrier error", cause: "Internal server error from carrier", description: "Carrier encountered an error", nextSteps: "Retry. If persistent, contact support" },
  3090: { group: "Carrier error", cause: "Network congestion from carrier", description: "Carrier network overloaded", nextSteps: "Retry with backoff" },
  3100: { group: "Carrier error", cause: "Busy everywhere", description: "All destination endpoints busy", nextSteps: "Retry later" },
  3110: { group: "Carrier error", cause: "Declined", description: "Destination cannot or won't participate", nextSteps: "Verify the destination accepts calls" },
  3120: { group: "Carrier error", cause: "User does not exist anywhere", description: "End user doesn't exist", nextSteps: "Verify the destination number" },
  3130: { group: "Carrier error", cause: "Spam block", description: "Carrier rejected the call due to a spam flag", nextSteps: "Register the number with STIR/SHAKEN. Consider a different caller ID" },
  3140: { group: "Carrier error", cause: "DNO Caller ID", description: "Caller ID on the Do Not Originate list", nextSteps: "Use a different number. This one is inbound-only" },
  5000: { group: "System error", cause: "Network Error", description: "Fatal network condition", nextSteps: "Contact Vobiz support with the call UUID" },
  5010: { group: "System error", cause: "Internal Error", description: "Vobiz system error", nextSteps: "Contact Vobiz support with the call UUID" },
  5020: { group: "System error", cause: "Routing Error", description: "Could not route to destination", nextSteps: "Contact Vobiz support with the call UUID" },
  5030: { group: "System error", cause: "Concurrency Limit Breached", description: "India concurrent call limit exceeded", nextSteps: "Reduce active calls or upgrade CPS to increase capacity" },
  6000: { group: "Timeout", cause: "Scheduled Hangup", description: "Max call duration reached", nextSteps: "None. Configure time_limit (API) or timeLimit (Dial XML) if longer calls are needed" },
  6010: { group: "Timeout", cause: "Ring Timeout Reached", description: "Not answered within the ring timeout", nextSteps: "Increase ring_timeout (API) or timeout (Dial XML). Default is 120 seconds" },
  6020: { group: "Timeout", cause: "Media Timeout", description: "No media packets for 60 seconds", nextSteps: "Check network connectivity. May indicate a lost connection" },
  7011: { group: "URL error", cause: "Error Reaching Answer URL", description: "Non-2xx response from the answer URL", nextSteps: "Verify the URL is accessible. Check server logs" },
  7012: { group: "URL error", cause: "Error Reaching Action URL", description: "Non-2xx response from the action URL", nextSteps: "Verify the URL is accessible (only fails if redirect=true)" },
  7013: { group: "URL error", cause: "Error Reaching Transfer URL", description: "Non-2xx response from the transfer URL", nextSteps: "Verify the URL is accessible" },
  7014: { group: "URL error", cause: "Error Reaching Redirect URL", description: "Non-2xx response from the redirect URL", nextSteps: "Verify the URL is accessible" },
  7022: { group: "URL error", cause: "Invalid Action URL", description: "Action URL not valid", nextSteps: "Ensure the URL starts with http:// or https://" },
  7023: { group: "URL error", cause: "Invalid Transfer URL", description: "Transfer URL not valid", nextSteps: "Ensure the URL starts with http:// or https://" },
  7024: { group: "URL error", cause: "Invalid Redirect URL", description: "Redirect URL not valid", nextSteps: "Ensure the URL starts with http:// or https://" },
  7032: { group: "URL error", cause: "Invalid Method For Action URL", description: "Unsupported HTTP method", nextSteps: "Use only GET or POST" },
  7033: { group: "URL error", cause: "Invalid Method For Transfer URL", description: "Unsupported HTTP method", nextSteps: "Use only GET or POST" },
  7034: { group: "URL error", cause: "Invalid Method For Redirect URL", description: "Unsupported HTTP method", nextSteps: "Use only GET or POST" },
  8011: { group: "XML error", cause: "Invalid Answer XML", description: "Answer URL returned invalid XML", nextSteps: "Check debug logs in Console. Validate XML syntax" },
  8012: { group: "XML error", cause: "Invalid Action XML", description: "Action URL returned invalid XML", nextSteps: "Check debug logs. Only fails if redirect=true" },
  8013: { group: "XML error", cause: "Invalid Transfer XML", description: "Transfer URL returned invalid XML", nextSteps: "Check debug logs. Validate XML syntax" },
  8014: { group: "XML error", cause: "Invalid Redirect XML", description: "Redirect URL returned invalid XML", nextSteps: "Check debug logs. Validate XML syntax" },
  9000: { group: "Special case", cause: "Lost Race", description: "Another parallel B-leg answered first", nextSteps: "None. Normal for simultaneous dial" },
  9100: { group: "Special case", cause: "Machine Detected", description: "Answered by an answering machine", nextSteps: "None. Occurs when machine_detection=hangup" },
  9110: { group: "Special case", cause: "Confirm Key Challenge Failed", description: "Participant failed to enter the confirm key", nextSteps: "Inform the participant of the required DTMF input" },
};

/** Textual `hangup_cause` values from the SIP / B2BUA layer. */
export const SIP_HANGUP_CAUSES: Record<string, string> = {
  NORMAL_CLEARING: "One of the parties hung up normally",
  USER_BUSY: "The called party is busy (already on another call or declined)",
  NO_ANSWER: "The called party did not answer within the timeout period",
  ORIGINATOR_CANCEL: "The caller cancelled the call before it was answered",
  CALL_REJECTED: "The destination explicitly rejected the call",
  REJECTED: "General rejection. The SIP endpoint refused the INVITE",
  INVALID_NUMBER: "The dialed number format is invalid",
  UNALLOCATED_NUMBER: "The dialed number is valid but not allocated to any subscriber",
  SERVICE_UNAVAILABLE: "The destination service is temporarily unavailable (SIP 503)",
  SERVER_ERROR: "An internal server error occurred during call setup",
  MEDIA_TIMEOUT: "No RTP media packets received. Likely a firewall or network issue",
  PROTOCOL_ERROR: "A SIP protocol violation or malformed message",
  NETWORK_OUT_OF_ORDER: "A severe network failure prevented routing",
  DESTINATION_OUT_OF_ORDER: "The destination endpoint cannot accept the call",
  NORMAL_TEMPORARY_FAILURE: "Generic temporary failure. Retrying may succeed",
  SWITCH_CONGESTION: "The SIP switch is at capacity",
  UNKNOWN: "An error not mapped to a standard cause code",
};

/** `hangup_source`: who or what ended the call. Keys are lower-cased for lookup. */
export const HANGUP_SOURCES: Record<string, string> = {
  caller: "Call hung up by the caller",
  "call recipient": "Call hung up by the dialed party",
  vobiz: "Vobiz initiated the hangup",
  carrier: "Hangup signal from the remote carrier",
  "api request": "Terminated via the Hangup or Cancel Call API",
  "answer xml": "Hung up using the Hangup XML element",
  error: "An error condition terminated the call",
  unknown: "Hangup source could not be determined",
};

/** SIP response codes the docs explain (failure_code / SIP status on a CDR). */
export const SIP_RESPONSES: Record<string, { name: string; meaning: string; next: string }> = {
  "480": {
    name: "Temporarily Unavailable",
    meaning:
      "The receiving device could not be reached: switched off, out of coverage, in airplane mode or Do Not Disturb, or the operator timed out before it could answer",
    next: "If you see 480 or 486 against many different numbers on one carrier, the operator's spam filter may have blocked your caller ID: pause dialing for several hours or contact support",
  },
  "486": {
    name: "Busy Here",
    meaning: "The callee's device is on another call without call waiting, or the recipient rejected the call",
    next: "If you see 480 or 486 against many different numbers on one carrier, the operator's spam filter may have blocked your caller ID: pause dialing for several hours or contact support",
  },
};

/** Thresholds above/below which the docs say to flag a call-quality issue separately from the hangup cause. */
export const QUALITY = { minMos: 3.5, maxJitterMs: 30, maxPacketLossPct: 1 } as const;

/** Messaging statuses (Message.status in the Messaging API spec). */
export const MESSAGE_STATUSES: Record<string, string> = {
  scheduled: "Held until its scheduledAt time; it has not been sent yet",
  sent: "Handed to the network. This is not delivery: wait for delivered or failed",
  delivered: "Delivery to the handset was confirmed",
  failed: "The message failed; errorCode and errorMessage say why",
  received: "An inbound message one of your numbers received",
  unknown: "The network reported a status that maps to none of the others; read the status history",
};
