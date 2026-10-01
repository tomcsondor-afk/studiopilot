import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePublicUrl, isPrivateIp } from "../src/ssrf.js";
import { parseRobots, robotsAllows } from "../src/crawler.js";

test("rejects private, local, metadata and malformed URLs", () => {
  for (const bad of ["http://localhost/", "http://127.0.0.1/", "http://169.254.169.254/latest/meta-data", "http://10.1.2.3", "http://[::1]/", "http://metadata.google.internal/",
    "ftp://example.com", "https://user:pass@example.com", "https://example.com:8080/", "http://192.168.1.1", "http://intranet", "http://printer.local", "javascript:alert(1)"]) {
    assert.throws(() => parsePublicUrl(bad), `${bad} should be rejected`);
  }
});

test("accepts ordinary public URLs and normalises bare domains", () => {
  assert.equal(parsePublicUrl("example.co.uk").href, "https://example.co.uk/");
  assert.equal(parsePublicUrl("https://www.example.com/about#team").href, "https://www.example.com/about");
});

test("classifies private IPs including IPv4-mapped IPv6", () => {
  assert.ok(isPrivateIp("::ffff:127.0.0.1"));
  assert.ok(isPrivateIp("fd00::1"));
  assert.ok(isPrivateIp("100.64.0.1"));
  assert.ok(!isPrivateIp("93.184.216.34"));
});

test("robots.txt: specific agent group wins, longest match decides", () => {
  const r = parseRobots("User-agent: *\nDisallow: /\n\nUser-agent: StudioPilotBot\nDisallow: /private\nAllow: /private/public\nCrawl-delay: 3");
  assert.ok(robotsAllows(r, "/about"));
  assert.ok(!robotsAllows(r, "/private/x"));
  assert.ok(robotsAllows(r, "/private/public/page"));
  assert.equal(r.delay, 3);
  const all = parseRobots("User-agent: *\nDisallow: /");
  assert.ok(!robotsAllows(all, "/anything"));
});
