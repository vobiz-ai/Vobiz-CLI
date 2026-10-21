import { describe, expect, it } from "vitest";
import { explainCdr, explainMessage } from "../src/commands/diagnose.js";
import { fakeFetch, reply, runCli, TEST_AUTH_ID } from "./helpers.js";

const UUID = "6d8f9a2e-1b3c-4d5e-8f70-123456789abc";
const A = `/api/v1/Account/${TEST_AUTH_ID}`;
const CDR = `GET ${A}/cdr/${UUID}`;
const LIVE = `GET ${A}/Call/${UUID}`;
const QUEUED = `GET ${A}/Call/${UUID}/`;
const RECORDINGS = `GET ${A}/Recording/`;
const STREAMS = `GET ${A}/Call/${UUID}/Stream/`;

const busy = {
  uuid: UUID,
  call_direction: "outbound",
  caller_id_number: "+918065550100",
  destination_number: "+919876543210",
  start_time: "2026-10-21T10:53:29Z",
  answer_time: null,
  duration: 7,
  billsec: 0,
  hangup_cause: "USER_BUSY",
  hangup_cause_code: 3010,
  hangup_cause_name: "Busy Line",
  hangup_source: "Call recipient",
  mos: 4.4,
  jitter: 0,
  packet_loss: 0,
  total_cost: 0,
  currency: "INR",
};
const recordings = {
  meta: { limit: 100, offset: 0, total_count: 2 },
  objects: [
    { recording_id: "rec-1", call_uuid: UUID, recording_url: "https://recordings.vobiz.ai/x.mp3" },
    { recording_id: "rec-2", call_uuid: "other" },
  ],
};

describe("vobiz diagnose call", () => {
  it("explains a finished call from its record and finds its recordings (json shape)", async () => {
    const api = fakeFetch({ [CDR]: { data: busy, success: true }, [RECORDINGS]: recordings });
    const r = await runCli(["diagnose", "call", UUID, "--json"], { fetch: api.fetch });
    expect(r.code).toBe(0);
    const d = r.json();
    expect(Object.keys(d)).toEqual(["facts", "explanation", "next_steps", "links"]);
    expect(d.facts).toMatchObject({ call_uuid: UUID, state: "completed", direction: "outbound", hangup_cause_code: 3010, hangup_source: "Call recipient", recordings: 1 });
    expect(d.facts).not.toHaveProperty("streams");
    expect(d.explanation.join("\n")).toContain('Hangup code 3010, "Busy Line" (call rejection): Destination is busy.');
    expect(d.explanation.join("\n")).toContain("hangup_cause USER_BUSY: The called party is busy");
    expect(d.explanation.join("\n")).toContain("Ended by: Call recipient. Call hung up by the dialed party.");
    expect(d.explanation.join("\n")).toContain("rec-1");
    expect(d.next_steps).toContain("Retry later or implement voicemail fallback.");
    expect(d.next_steps).toContain("Listen to it: `vobiz recordings download rec-1`.");
    expect(d.links).toContain("https://www.vobiz.ai/docs/concepts/hangup-causes");
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([CDR, RECORDINGS]);
    expect(api.calls[1].query).toEqual({ limit: "100", offset: "0" });
    expect(api.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("prints facts, what happened, next steps and docs in table mode", async () => {
    const api = fakeFetch({ [CDR]: busy, [RECORDINGS]: { objects: [] } });
    const r = await runCli(["diagnose", "call", UUID, "--output", "table"], { fetch: api.fetch });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/hangup_cause_code\s+3010/);
    expect(r.out).toContain("What happened:\n  - The call was not answered");
    expect(r.out).toContain("What to check next:\n  1. Retry later or implement voicemail fallback.");
    expect(r.out).toContain("Docs:\n  https://www.vobiz.ai/docs/concepts/hangup-causes");
  });

  it("falls back to the live call (with its streams) and then the queued call", async () => {
    let api = fakeFetch({
      [CDR]: reply(404, { error: "not found" }),
      [LIVE]: { call_uuid: UUID, call_status: "in-progress", direction: "outbound", from: "+918065550100", to: "+919876543210" },
      [RECORDINGS]: { objects: [] },
      [STREAMS]: { objects: [{ stream_id: "s-1", status: "in-progress" }] },
    });
    let r = await runCli(["diagnose", "call", UUID, "--json"], { fetch: api.fetch });
    expect(r.code).toBe(0);
    expect(r.json().facts).toMatchObject({ state: "live", status: "in-progress", streams: 1 });
    expect(r.json().explanation[0]).toContain("still up (status in-progress)");
    expect(r.json().next_steps[0]).toContain(`vobiz calls watch ${UUID}`);
    expect(api.calls.find((c) => c.path === `${A}/Call/${UUID}`)?.query).toEqual({ status: "live" });

    api = fakeFetch({ [CDR]: reply(404, {}), [LIVE]: reply(404, {}), [QUEUED]: { call_uuid: UUID, call_status: "queued" }, [RECORDINGS]: { objects: [] }, [STREAMS]: reply(404, {}) });
    r = await runCli(["diagnose", "call", UUID, "--json"], { fetch: api.fetch });
    expect(r.json().facts).toMatchObject({ state: "queued", streams: 0 });
    expect(api.calls.find((c) => c.path === `${A}/Call/${UUID}/`)?.query).toEqual({ status: "queued" });
  });

  it("exits 4 when no record, live or queued call exists, and reports recordings it could not check", async () => {
    let api = fakeFetch({ [CDR]: reply(404, {}), [LIVE]: reply(404, {}), [QUEUED]: reply(404, {}) });
    let r = await runCli(["diagnose", "call", UUID], { fetch: api.fetch });
    expect(r.code).toBe(4);
    expect(r.err).toContain("cdr recent");

    api = fakeFetch({ [CDR]: busy, [RECORDINGS]: reply(500, { error: "boom" }) });
    r = await runCli(["diagnose", "call", UUID, "--json"], { fetch: api.fetch });
    expect(r.code).toBe(0);
    expect(r.json().facts.recordings).toBe("not checked (boom)");
  });

  it("--query and --scan work", async () => {
    const api = fakeFetch({ [CDR]: busy, [RECORDINGS]: recordings });
    const r = await runCli(["diagnose", "call", UUID, "--scan", "5", "--query", "facts.hangup_cause", "--output", "plain"], { fetch: api.fetch });
    expect(r.out).toBe("USER_BUSY\n");
    expect(api.calls[1].query).toEqual({ limit: "5", offset: "0" });
  });
});

describe("explainCdr", () => {
  it("never invents a meaning for an undocumented code or cause", () => {
    const d = explainCdr({ uuid: UUID, hangup_cause_code: 4242, hangup_cause: "SOMETHING_NEW", hangup_source: "Callee" });
    const text = d.explanation.join("\n");
    expect(text).toContain("Hangup code 4242 is not in the documented code table; see https://www.vobiz.ai/docs/concepts/hangup-causes");
    expect(text).toContain("hangup_cause SOMETHING_NEW is not in the documented SIP cause table");
    expect(text).toContain("Ended by: Callee.");
    expect(d.next_steps.join("\n")).toContain("contact support@vobiz.ai");
  });

  it("explains SIP 480/486 failure codes and flags poor quality separately", () => {
    const d = explainCdr({ uuid: UUID, failure_code: "480", hangup_cause: "NO_ANSWER", mos: 2.9, jitter: 45, packet_loss: 3 });
    const text = d.explanation.join("\n");
    expect(text).toContain("SIP 480 Temporarily Unavailable");
    expect(text).toContain("Audio quality issue, separate from the hangup cause: MOS 2.9 (below 3.5), jitter 45 ms (above 30 ms), packet loss 3% (above 1%).");
    expect(d.links).toContain("https://www.vobiz.ai/docs/faq/sip-codes-480-486");
  });

  it("points XML and URL errors at the right tools, and system errors at support", () => {
    expect(explainCdr({ uuid: UUID, hangup_cause_code: 8011 }).next_steps.join("\n")).toContain("vobiz xml validate");
    expect(explainCdr({ uuid: UUID, hangup_cause_code: 7011 }).next_steps.join("\n")).toContain("2xx");
    expect(explainCdr({ uuid: UUID, hangup_cause_code: 5010 }).next_steps).toEqual(["Contact Vobiz support with the call UUID."]);
    expect(explainCdr({ uuid: UUID, hangup_cause_code: 4000, hangup_cause: "NORMAL_CLEARING", billsec: 12 }).next_steps).toEqual([]);
  });
});

describe("vobiz diagnose message", () => {
  const MSG = "9b2e1c40-8a3d-4f5e-9c1a-7d6b2e8f4a01";
  it("explains a failed message with its history and India DLT checks", async () => {
    const api = fakeFetch({
      [`GET /messages/${MSG}`]: {
        id: MSG,
        direction: "out",
        channel: "sms",
        from: "VOBIZ",
        to: "+919876543210",
        status: "failed",
        statusHistory: [
          { status: "sent", createdAt: "2026-10-12T10:30:00Z" },
          { status: "failed", errorCode: "30007", errorMessage: "carrier filtered", createdAt: "2026-10-12T10:30:05Z" },
        ],
      },
    });
    const r = await runCli(["diagnose", "message", MSG, "--json"], { fetch: api.fetch });
    expect(r.code).toBe(0);
    expect(api.last()).toMatchObject({ api: "sms", method: "GET", path: `/messages/${MSG}` });
    const d = r.json();
    expect(d.facts).toMatchObject({ id: MSG, status: "failed", history: "sent @ 2026-10-12T10:30:00Z → failed @ 2026-10-12T10:30:05Z" });
    expect(d.explanation).toContain("Reason reported: 30007: carrier filtered.");
    expect(d.next_steps.join("\n")).toContain("vobiz sms opt-outs check +919876543210");
    expect(d.next_steps.join("\n")).toContain("DLT");
  });

  it("explains sent, unknown and undocumented statuses", () => {
    expect(explainMessage({ id: "m", status: "sent" }).explanation[0]).toContain("not delivery");
    expect(explainMessage({ id: "m", status: "unknown" }).next_steps[0]).toContain("status history");
    expect(explainMessage({ id: "m", status: "weird" }).explanation[0]).toContain("not one of the documented message statuses");
  });
});
