import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { feedProblem, fetchGtecMonth, parseFeedText, cjrMonthUrl, monthKeyOf, _resetFeedSources } from "../src/gtecFeed.js";

const ev = (d, name = "AU Ultimate Club (Field 2)") => ({ EventName: name, EventStartDate: d, EventDateTime: `${d}, 6:30 pm to 8:30 pm` });
const OCT = [ev("29/09/2026"), ev("06/10/2026"), ev("13/10/2026")];
const res = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => typeof body === "string" ? body : JSON.stringify(body) });

beforeEach(() => _resetFeedSources());

test("parseFeedText: raw list, relay wrapper, {events}", () => {
  assert.equal(parseFeedText(JSON.stringify(OCT)).length, 3);
  assert.equal(parseFeedText(JSON.stringify({ contents: JSON.stringify(OCT) })).length, 3);
  assert.equal(parseFeedText(JSON.stringify({ events: OCT })).length, 3);
  assert.throws(() => parseFeedText("<html>blocked</html>"));
  assert.throws(() => parseFeedText('{"error":"rate limited"}'), /not a GTEC calendar feed/);
});

test("monthKeyOf / cjrMonthUrl use the 0-based month", () => {
  assert.equal(monthKeyOf(2026, 9), "2026-10");
  assert.match(cjrMonthUrl(2026, 9), /date=2026-10-01$/);
});

test("feedProblem: an empty feed is refused only while GTEC blocks are saved", () => {
  assert.equal(feedProblem([], 2026, 9, 0), "");
  assert.match(feedProblem([], 2026, 9, 12), /empty.*12 GTEC blocks are saved/);
  assert.match(feedProblem([], 2026, 9, 1), /1 GTEC block is saved/);
});

test("feedProblem: the wrong month, undated entries and non-lists are refused", () => {
  assert.equal(feedProblem(OCT, 2026, 9, 5), "");
  assert.match(feedProblem([ev("03/08/2026")], 2026, 9), /holds 2026-08, not 2026-10/);
  assert.match(feedProblem([{ EventName: "x" }], 2026, 9), /none of the entries has a date/);
  assert.match(feedProblem(null, 2026, 9), /wasn't a list/);
  // Boundary days of the neighbouring months are fine as long as the month itself is there.
  assert.equal(feedProblem([ev("30/09/2026"), ev("01/10/2026")], 2026, 9), "");
});

test("fetchGtecMonth: the edge function is tried first", async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => { calls.push({ url, opts }); return res(200, OCT); };
  const out = await fetchGtecMonth(2026, 9, { functionUrl: "https://x/functions/v1/gtec-feed", headers: { apikey: "k" }, fetchImpl });
  assert.equal(out.source, "server");
  assert.equal(out.events.length, 3);
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].opts.body), { year: 2026, month: 10 });
});

test("fetchGtecMonth: an empty answer while blocks are saved moves on to a relay with the real feed", async () => {
  const fetchImpl = async url => url.includes("gtec-feed") ? res(200, []) : res(200, OCT);
  const out = await fetchGtecMonth(2026, 9, { functionUrl: "https://x/functions/v1/gtec-feed", headers: {}, savedBlocks: 4, fetchImpl });
  assert.equal(out.source, "allorigins");
  assert.equal(out.events.length, 3);
});

test("fetchGtecMonth: an undeployed function (404) is skipped next time; relays are the fallback", async () => {
  let fnCalls = 0;
  const fetchImpl = async url => { if (url.includes("gtec-feed")) { fnCalls++; return res(404, "not found"); } return url.includes("codetabs") ? res(200, OCT) : res(500, "down"); };
  const opts = { functionUrl: "https://x/functions/v1/gtec-feed", headers: {}, fetchImpl, retryDelayMs: 0 };
  assert.equal((await fetchGtecMonth(2026, 9, opts)).source, "codetabs");
  assert.equal((await fetchGtecMonth(2026, 9, opts)).source, "codetabs");
  assert.equal(fnCalls, 1);
});

test("fetchGtecMonth: throws with every reason when nothing gives a usable feed", async () => {
  const fetchImpl = async url => url.includes("allorigins.win/raw") ? res(200, []) : res(503, "busy");
  await assert.rejects(fetchGtecMonth(2026, 9, { savedBlocks: 3, fetchImpl, retryDelayMs: 0 }), err => {
    assert.match(err.message, /Couldn't read GTEC's calendar/);
    assert.match(err.message, /came back empty/);
    assert.match(err.message, /HTTP 503/);
    return true;
  });
  // The relays aren't retried straight away for the next month.
  let calls = 0;
  await assert.rejects(fetchGtecMonth(2026, 10, { fetchImpl: async () => { calls++; return res(200, OCT); } }), /all failed moments ago/);
  assert.equal(calls, 0);
});
