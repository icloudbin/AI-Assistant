// scripts/test-pii-cn-address.mjs
//
// Regression test for the Chinese street-address rule of the PII filter
// (CN_ADDRESS_RE in privacy/pii-filter.js).
//
// The rule matched the region words with nested quantifiers:
//   (?:[一-龥]{2,9}(?:省|自治区|特别行政区|市|区|县|镇|乡)){1,4} ...
// A name can be cut into groups in many ways, and with no street behind it the
// engine tried every cut at every start position before giving up: 8,000 区
// took 1.3 s, 16,000 took 2.5 s, 60,000 about 10 s - and a page is read up to
// 120,000 characters. The filter runs synchronously in the service worker, so a
// web page (or a pasted text) made of region words froze the extension for tens
// of seconds. The guard in front of the rule did not help: it asked only for a
// road character somewhere in the text, and 道 and 同 are in almost every
// Chinese text ("知道", "同意").
//
// Each region group is now matched atomically, and the guard asks for what the
// rule needs: a road character directly followed by a digit.
//
// Run with:  node scripts/test-pii-cn-address.mjs
//
// Part 1 pins the behaviour. Part 2 compares the filter with the old pattern on
// several corpora. Part 3 is the performance regression test.

import assert from "node:assert/strict";
import { createRedactionSession, redactSensitive, restorePlaceholders } from "../privacy/pii-filter.js";

// The pattern the rule used before: the behavioural reference for Part 2.
const LEGACY_CN_ADDRESS_RE = /(?:[一-龥]{2,9}(?:省|自治区|特别行政区|市|区|县|镇|乡)){1,4}[一-龥\d]{0,12}?(?:路|街|大道|巷|弄|胡同)\d{1,5}(?:号|號)?(?:[一-龥\d-]{0,12}?(?:栋|幢|号楼|单元|室|楼|层|座))*/g;
const legacy = (s) => s.replace(LEGACY_CN_ADDRESS_RE, "[ADDRESS]");

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push(true);
    console.log(`PASS  ${name}`);
  } catch (err) {
    results.push(false);
    console.log(`FAIL  ${name}\n      ${String(err?.message || err).split("\n").join("\n      ")}`);
  }
}
const ms = (fn) => {
  const t = performance.now();
  fn();
  return performance.now() - t;
};
const repeatTo = (unit, chars) => unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars);

// ---- Part 1: behaviour -----------------------------------------------------

await test("a street address is redacted with its number and building", () => {
  const cases = [
    ["地址：北京市朝阳区建国路88号3号楼502室", "地址：[ADDRESS]"],
    ["广东省深圳市南山区科技园路1号", "[ADDRESS]"],
    ["新疆维吾尔自治区乌鲁木齐市天山区解放北路100号", "[ADDRESS]"],
    ["内蒙古自治区呼和浩特市赛罕区大学东街1号", "[ADDRESS]"],
    ["北京市东城区东直门内大街12号", "[ADDRESS]"],
    ["山东省济南市市中区经七路1号", "[ADDRESS]"],
    ["公司：浙江省杭州市西湖区文三路90號东部软件园2幢", "公司：[ADDRESS]"],
    ["收件地址：江苏省苏州市吴中区木渎镇金枫南路1号5栋2单元301室，请尽快发货", "收件地址：[ADDRESS]，请尽快发货"],
    ["寄到：北京市朝阳区建国路88号；备用：上海市浦东新区世纪大道100号", "寄到：[ADDRESS]；备用：[ADDRESS]"],
  ];
  for (const [input, expected] of cases) assert.equal(redactSensitive(input), expected, input);
});

await test("text without a street and a number is left alone", () => {
  for (const s of [
    "我住在北京市朝阳区",
    "建国路88号", // no region in front
    "北京市朝阳区建国路", // no number
    "第1路公交车到站了",
    "市场路88号很热闹",
    "我知道1个办法",
    "同1个问题",
    "他在朝阳区工作，在建国路上班",
    "区区区区区区区区",
  ]) {
    assert.equal(redactSensitive(s), s, s);
  }
});

await test("full-width digits and the numbered placeholders of a session still work", () => {
  assert.equal(redactSensitive("地址：北京市朝阳区建国路８８号３号楼５０２室"), "地址：[ADDRESS]");
  for (const original of ["收件：北京市朝阳区建国路88号3号楼502室；备用：上海市浦东新区世纪大道100号", "地址：北京市朝阳区建国路８８号３号楼５０２室"]) {
    const session = createRedactionSession();
    const redacted = redactSensitive(original, session);
    assert.match(redacted, /\[ADDRESS#1\]/);
    assert.ok(!/建国路|世纪大道/.test(redacted), redacted);
    assert.equal(restorePlaceholders(redacted, session), original);
  }
});

// ---- Part 2: the same matches as the old pattern ---------------------------
//
// The filter runs about ninety rules; the corpora below hold nothing the others
// match, and a string on which one of them fires anyway is skipped (and
// counted), so what is compared is the address rule.

const onlyAddressPlaceholders = (out) => !/\[(?!ADDRESS\])/.test(out);
function compare(strings, relation) {
  let compared = 0;
  let skipped = 0;
  let matched = 0;
  const deviations = [];
  for (const s of strings) {
    const actual = redactSensitive(s);
    if (!onlyAddressPlaceholders(actual)) { skipped++; continue; }
    const expected = legacy(s);
    compared++;
    if (expected !== s) matched++;
    if (actual === expected) continue;
    deviations.push({ s, actual, expected });
    if (relation) relation(s, actual, expected);
  }
  return { compared, skipped, matched, deviations };
}
const show = (d) => d.slice(0, 3).map((x) => `${JSON.stringify(x.s)}\n        got      ${JSON.stringify(x.actual)}\n        expected ${JSON.stringify(x.expected)}`).join("\n      ");

// deterministic pseudo-random numbers
const lcg = (seed) => () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;

// What a looser reading of "region words in groups" gets wrong, found by
// comparing candidate patterns with the old one. Each of these has region words
// packed closely (济南市 + 市中区) behind a run of ordinary characters: a group
// that always takes the LONGEST span ends at the second 市 and strands 中区,
// so that variant started the match a few characters late and left the first
// characters of the address in the clear ("他[ADDRESS]", "北[ADDRESS]").
await test("agrees with the old pattern where region words sit side by side", () => {
  const strings = [
    "他现在住在济南市市中区高新技术产业开发区翠微路885号5栋2单元301室，邮编已发",
    "收件地址是深圳市市中区龙华街道华为基地大石桥胡同88号B栋 联系人：王",
    "请寄乐山市市中区大浪街道天府软件园粤海街1号3楼。",
    "（北京市乌鲁木齐市市中区高新技术产业开发区科苑路2弄1单元，谢谢",
    "内蒙古自治区乌鲁木齐市市南区龙华街道天府软件园中山路1号1单元，谢谢",
    "从西藏自治区拉萨市市辖区大浪街道科技园王府井大街88號28层，谢谢",
    "我住苏州市市辖区龙华街道清华科技园科苑路883号楼-502",
    "济南市市中区某某某某某某某某某某某路1",
    "某某某某某某某市市某市某某某某某某某某某某某路1",
  ];
  const r = compare(strings);
  assert.equal(r.skipped, 0);
  assert.equal(r.matched, strings.length, "every string holds an address the old pattern finds");
  assert.equal(r.deviations.length, 0, show(r.deviations));
});

await test("agrees with the old pattern on composed addresses (province, city, district, town, street, number, building)", () => {
  const provinces = ["", "北京市", "广东省", "新疆维吾尔自治区", "香港特别行政区", "内蒙古自治区", "山东省"];
  const cities = ["", "深圳市", "济南市", "乌鲁木齐市", "苏州市", "乐山市"];
  const districts = ["", "朝阳区", "浦东新区", "市中区", "市南区", "市辖区", "高新区", "崇明县"];
  const towns = ["", "木渎镇", "龙华街道", "八宝山乡"];
  const places = ["", "中关村", "张江高科技园区", "科技园", "高新技术产业开发区", "清华科技园"];
  const roads = ["建国路", "解放大道", "长安街", "大石桥胡同", "花园巷", "新村弄", "东直门内大街", "祖冲之路"];
  const numbers = ["1", "88", "100号", "88號", "12345", "6号院"];
  const buildings = ["", "3号楼502室", "5栋2单元301室", "A座10层", "12幢"];
  const leads = ["", "地址：", "我住在", "请寄", "收件地址是", "他现在住在", "（", "，从"];
  const tails = ["", "，谢谢", "。", " 联系人：王"];
  const strings = [];
  let k = 0;
  for (let pass = 0; pass < 3; pass++) {
    for (const p of provinces) for (const c of cities) for (const d of districts) for (const t of towns) for (const pl of places) {
      k++;
      strings.push(
        leads[(k + pass) % leads.length] + p + c + d + t + pl +
        roads[(k >> 1) % roads.length] + numbers[(k >> 2) % numbers.length] + buildings[(k >> 3) % buildings.length] +
        tails[(k >> 4) % tails.length],
      );
    }
  }
  const r = compare(strings);
  assert.ok(r.compared > 20000, `only ${r.compared} strings were compared`);
  assert.ok(r.skipped < r.compared / 20, `${r.skipped} strings were skipped`);
  assert.ok(r.matched > r.compared / 2, "most of the corpus must hold an address");
  assert.equal(r.deviations.length, 0, `${r.deviations.length} of ${r.compared} differ\n      ${show(r.deviations)}`);
});

await test("agrees with the old pattern on every short sequence of an adversarial alphabet", () => {
  // 某 stands for any ordinary character: a 1-character, a 2-character and a 7-character name.
  const alphabet = ["某", "某某", "某某某某某某某", "市", "区", "路1", "1"];
  const strings = [];
  const walk = (prefix, depth) => {
    if (prefix) strings.push(prefix);
    if (depth === 0) return;
    for (const t of alphabet) walk(prefix + t, depth - 1);
  };
  walk("", 6);
  const r = compare(strings);
  assert.ok(r.compared > 100000, `only ${r.compared} strings were compared`);
  assert.ok(r.matched > 10000, `only ${r.matched} of them hold an address`);
  assert.equal(r.deviations.length, 0, show(r.deviations));
});

await test("agrees with the old pattern on random sequences of names, region words, streets, numbers and buildings", () => {
  const rand = lcg(20261118);
  const pick = (a) => a[Math.floor(rand() * a.length)];
  const names = ["北京", "朝阳", "上海", "浦东新", "建国", "世纪", "东", "西", "花园", "科技", "新疆维吾尔", "内蒙古", "镇海", "市中", "乡宁", "县前", "解放", "中山", "人民", "海淀", "中关村", "广东", "深圳", "南山", "粤海"];
  const regionWords = ["省", "市", "区", "县", "镇", "乡", "自治区", "特别行政区"];
  const streets = ["路", "街", "大道", "巷", "弄", "胡同"];
  const numbers = ["1", "23", "88", "100", "12345", "123456"];
  const haos = ["号", "號", ""];
  const buildings = ["栋", "幢", "号楼", "单元", "室", "楼", "层", "座"];
  const noise = ["-", " ", "，", "a", "知道", "的", "：", "\n", "区区区", "市市"];
  const kinds = [names, names, names, names, regionWords, regionWords, regionWords, regionWords, regionWords, streets, streets, streets, numbers, numbers, numbers, haos, haos, buildings, buildings, buildings, noise, noise];
  const strings = [];
  for (let i = 0; i < 100000; i++) {
    const n = 1 + Math.floor(rand() * (rand() < 0.5 ? 8 : 18));
    let s = "";
    for (let j = 0; j < n; j++) s += pick(pick(kinds));
    strings.push(s);
  }
  const r = compare(strings);
  assert.ok(r.compared > 90000, `only ${r.compared} strings were compared`);
  assert.ok(r.matched > 3000, `only ${r.matched} of them hold an address`);
  assert.equal(r.deviations.length, 0, show(r.deviations));
});

// Four region groups of up to nine characters each can be cut in more ways than
// the atomic groups try (the longest span, then the shortest). On strings with
// three to six region words at particular spacings and then a name of eight or
// more characters - about 1 in 100,000 of the strings generated here, none of
// the 60,000 below - the match may begin a few characters LATER than the old
// one's. The contract that holds, and is checked here: the same number of
// matches, each ending where the old one ended, never starting earlier, so the
// street, the number and the building are redacted exactly as before.
await test("deep chains of region words: same matches, same ends, never an earlier start", () => {
  const rand = lcg(777);
  const int = (a, b) => a + Math.floor(rand() * (b - a + 1));
  const pick = (a) => a[Math.floor(rand() * a.length)];
  const units = ["省", "市", "区", "县", "镇", "乡", "市", "区", "自治区", "特别行政区"];
  const streets = ["路1", "街23", "大道88", "巷5", "弄100", "胡同7", "路12345"];
  const strings = [];
  for (let i = 0; i < 60000; i++) {
    let s = rand() < 0.3 ? "我住在" : "";
    const groups = int(1, 6);
    for (let g = 0; g < groups; g++) s += "某".repeat(int(0, 10)) + pick(units);
    s += "某".repeat(int(0, 15)) + (rand() < 0.2 ? "1" : "") + (rand() < 0.2 ? "某某" : "") + pick(streets);
    if (rand() < 0.3) s += pick(["号", "號", "号楼", "室", "栋2单元301室", "-502"]);
    strings.push(s);
  }
  const PLACEHOLDER = "[ADDRESS]";
  const r = compare(strings, (s, actual, expected) => {
    const a = actual.split(PLACEHOLDER);
    const e = expected.split(PLACEHOLDER);
    assert.equal(a.length, e.length, `number of matches: ${JSON.stringify(s)}`);
    assert.equal(a.at(-1), e.at(-1), `a match ends elsewhere: ${JSON.stringify(s)}`);
    for (let i = 0; i < e.length - 1; i++) assert.ok(a[i].startsWith(e[i]), `a match starts earlier: ${JSON.stringify(s)}`);
  });
  assert.ok(r.compared > 55000, `only ${r.compared} strings were compared`);
  assert.ok(r.matched > 40000, `only ${r.matched} of them hold an address`);
  assert.ok(r.deviations.length <= 5, `${r.deviations.length} of ${r.matched} differ (a grouping that only tries the longest span: 140)\n      ${show(r.deviations)}`);
});

// ---- Part 3: performance ---------------------------------------------------
//
// The old pattern needed 2.4-12 s for five of these seven inputs at 60,000
// characters (up to about 200 us per character); the new one needs about 0.1 s, and
// the threshold leaves more than 10x headroom over that, so it is not
// timing-flaky. The other two inputs were never slow; they guard the new pattern.

const N = 60000;
const adversarial = {
  "区 x N, then a street": () => repeatTo("区", N) + "路1",
  "市区 x N/2, then a street": () => repeatTo("市区", N) + "路1",
  "省市区县镇乡 repeated, then a street": () => repeatTo("省市区县镇乡", N) + "路1",
  "自治区特别行政区 repeated, then a street": () => repeatTo("自治区特别行政区", N) + "路1",
  "a 7-character name and 市, repeated, then a street": () => repeatTo("某某某某某某某市", N) + "路1",
  "70 x 区 and a street, repeated": () => repeatTo("区".repeat(70) + "路1", N),
  "知道 and 区 x N, a street character but no number": () => "知道" + repeatTo("区", N) + "路",
};
for (const [name, build] of Object.entries(adversarial)) {
  await test(`${N} characters of "${name}" redact in under 1.5 s`, () => {
    const text = build();
    const t = ms(() => redactSensitive(text));
    assert.ok(t < 1500, `took ${t.toFixed(0)} ms for ${text.length} characters`);
  });
}

await test("an address after a very long run of region words is still found, and quickly", () => {
  const text = `${repeatTo("区", 50000)}，地址：北京市朝阳区建国路88号3号楼502室`;
  let out;
  const t = ms(() => { out = redactSensitive(text); });
  assert.ok(out.endsWith("，地址：[ADDRESS]"), out.slice(-40));
  assert.ok(!out.includes("建国路"));
  assert.ok(t < 1500, `took ${t.toFixed(0)} ms`);
});

await test("realistic text is not slowed down: 120,000 characters with an address in every paragraph", () => {
  const paragraph = "我们的新办公室搬到了。请把货寄到：北京市朝阳区建国路88号3号楼502室，联系人王先生，知道的话请回复，同意即可。\n";
  const text = repeatTo(paragraph, 120000);
  let out;
  const t = ms(() => { out = redactSensitive(text); });
  assert.ok(t < 1500, `took ${t.toFixed(0)} ms`);
  assert.ok(!out.includes("建国路"), "an address survived");
});

await test("cost grows roughly linearly with the text (4x text is not ~16x time)", () => {
  const small = repeatTo("区", 15000) + "路1";
  const big = repeatTo("区", 60000) + "路1";
  redactSensitive(small); // warm up
  const tSmall = Math.max(ms(() => redactSensitive(small)), 20); // floor: avoid dividing by timer noise
  const tBig = ms(() => redactSensitive(big));
  assert.ok(tBig < tSmall * 10, `15k: ${tSmall.toFixed(0)} ms, 60k: ${tBig.toFixed(0)} ms`);
});

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
