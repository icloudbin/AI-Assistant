#!/usr/bin/env node
// Unit tests for the web-research trigger (onlineResearchTrigger in background.js).
// Run: node scripts/test-research-trigger.mjs
//
// The trigger decides, before the model is called, whether a question is sent to
// Tavily: "explicit" when the user told the assistant to search the web,
// "implicit" when the current page cannot answer the question (only if the
// "Automatically search the web" setting is on), null when no search happens.
//
// Code review #2: the explicit test matched WORDS, so "Which web search engines
// does the article mention?" and "联网搜索功能是怎么实现的？" were treated as orders
// (skipping the opt-out setting and restoring real names for the query), while
// "Don't search the web" was searched anyway; and the implicit test sent most
// Chinese questions the page already answered to the web, because every filler
// word between two content words counted as two missing words.
// The phrase lists below are labelled data: every entry in REQUESTS is an
// instruction, every entry in NOT_EXPLICIT is not one, REFUSALS tell the
// assistant not to search, and NEUTRAL says nothing about searching.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// The trigger is private to the service worker, so it is cut out of the source
// (test-auto-web-research.mjs reads background.js the same way) and run in a
// sandbox. The region holds only pure functions.
const source = readFileSync(new URL("../background.js", import.meta.url), "utf8");
const from = source.indexOf("// What the user said about searching the web");
const to = source.indexOf("// Drops the privacy filter's placeholder tokens");
assert.ok(from > 0 && to > from, "trigger source markers moved: update this test");
const { onlineResearchTrigger } = vm.runInNewContext(`${source.slice(from, to)}\n;({ onlineResearchTrigger });`, {});
const trigger = (question, pageText) => onlineResearchTrigger(question, pageText === undefined ? null : { text: pageText });

let failed = 0;
const check = (name, ok, extra = "") => { if (!ok) failed++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`); };
const all = (list, predicate) => list.filter((item) => !predicate(item));
const show = (bad) => bad.map((q) => JSON.stringify(q)).join(" | ");

const unrelatedPage = "Totally unrelated page text about gardening, soil acidity and tomato varieties.";

// --- Instructions to search the web -----------------------------------------
const REQUESTS = [
  "search the web for the latest Chrome version",
  "Please search the internet for reviews of the Pixel 9",
  "Can you search online for cheap flights to Lisbon?",
  "look it up online",
  "Look up the price of a Tesla Model 3 on the internet",
  "Find the current mortgage rate online",
  "Google the population of Portugal on the web",
  "Browse the web and tell me what people say about this product",
  "Could you please do a quick web search for this error message?",
  "Run an online search for the author's other books",
  "I want you to search the web and verify this claim",
  "My name is Jane Doe. Search the web for my publications.",
  "Summarize this page and then search online for competitors",
  "If you can't find it on the page, search the internet.",
  "Use the internet to find the release date",
  "Do an internet search on this topic",
  "Also search the web for a second opinion",
  "Google it online",
  "Search online.",
  "search the web: latest iPhone price",
  "You should search the web for this.",
  "Go search the web for it",
  "hey, can you look this up on the web for me?",
  "Please look up the 2026 tax brackets online and compare",
  "Search the web, don't answer from memory",
  "请联网搜索张三的公开论文",
  "帮我上网查一下最新的iPhone价格",
  "联网搜索一下Chrome最新版本",
  "你能不能联网搜索一下这个报错",
  "先总结这篇文章，然后上网搜索作者的其他作品",
  "去网上搜一下这家公司的评价",
  "在网上查找2026年的最新政策",
  "麻烦你在线搜索一下相关新闻",
  "请在网上搜索 Rust 1.80 的新特性",
  "上网查一查",
  "联网检索相关论文",
  "我想让你联网搜索最新的汇率",
  "我叫张三。请联网搜索张三的公开论文",
  "请 search the web for 最新的 iphone 价格",
  "Please do a web search and tell me who won the match",
  "pls google this online",
  "Look this up on the internet and summarise",
  "I need you to search the web for the exact quote",
  "Could you browse the internet and find similar articles?",
  "Search for it on the internet.",
  "Find me some reviews online",
  "Search the web (not just this page) for the current CEO",
  "Search the web - I need the current price",
  "Search the web!!",
  "Search the web\nfor the price",
  "SEARCH THE WEB FOR TAYLOR SWIFT TOUR DATES",
  "Please do a bit of online research on this company",
  "Could you search the internet to confirm the date?",
  "You can search the web for the answer, I don't mind",
  "Just search online for it",
  "Please look it up online and cite your sources",
  "Search the web and compare it with what this article claims",
  "你可以联网查一下吗？",
  "麻烦联网搜索一下，谢谢",
  "请你上网搜索这篇文章作者的背景",
  "能帮我网上查一下这个人吗",
  "你上网搜一下就知道了",
  "你去网上搜搜看",
  "请联网搜索并总结最新进展",
  "帮我在网上找找这个产品的评测",
  "联网搜索2026年世界杯赛程",
  "上网查一下今天的天气",
  "请你在线检索相关文献",
  "先看这篇文章，再去网上搜一下作者",
];
{
  const bad = all(REQUESTS, (q) => trigger(q) === "explicit");
  check(`explicit: ${REQUESTS.length} genuine instructions are recognised (English and Chinese)`, bad.length === 0, show(bad));
  // The instruction is judged on its own, whatever the page says.
  const withPage = all(REQUESTS, (q) => trigger(q, "A page that covers everything: " + q) === "explicit");
  check("explicit: a page that already mentions the topic does not turn an instruction into a local answer", withPage.length === 0, show(withPage));
  // Known limits, not asserted: "go online and check ...", "check online whether ...", a bare "web search this: ...".
}

// --- The same words, not an instruction ----------------------------------------
const NOT_EXPLICIT = [
  "Don't search the web, just use the page",
  "Please do not search online for this.",
  "No need to search the internet for it.",
  "Never look it up online",
  "Do not use the internet, only the page.",
  "I'd rather you didn't search the web",
  "Please don't browse the web for this",
  "You don't need to search online",
  "Let's not search the web for this one",
  "Answer from the page, do not search the web",
  "不要联网搜索，只根据页面回答",
  "别上网查了",
  "无需联网搜索",
  "请勿联网搜索",
  "我不想联网搜索",
  "你不能联网搜索吗？",
  "请不要上网搜索",
  "How do I search the web safely?",
  "Where can I find a good tutorial online?",
  "Can I search online without a VPN?",
  "Why would someone search online before buying?",
  "Is it safe to browse the internet on public Wi-Fi?",
  "What happens when I run a web search?",
  "The article explains how to search the web effectively.",
  "怎么联网搜索？",
  "如何上网查资料？",
  "网上找工作靠谱吗",
  "上网查资料的好处是什么",
  "网上搜索结果可信吗？",
  "Which web search engines does the article mention?",
  "Find all the online stores mentioned on this page",
  "Search for the word internet in this text",
  "What does the author say about web research?",
  "Summarize the section about online research methods",
  "Look up the definition of 'internet' in the glossary below",
  "Search this web page for the pricing section",
  "Check the web page for spelling errors",
  "Search online stores for deals on this page",
  "Find online courses mentioned in this article",
  "Explain how a web search works",
  "browse the internet archive for old pages",
  "Tell me about the history of the internet",
  "文章里提到了哪些网上搜索技巧？",
  "联网搜索功能是怎么实现的？",
  "这个设备怎么联网",
  "路由器联网失败是什么意思",
  "在线搜索引擎有哪些？",
  "这篇文章讲了什么",
  "I searched the web yesterday and found nothing",
  "Search engines index the web continuously.",
  "Chrome lets you search the web from the address bar",
  "To search the web, open a new tab.",
  "How to search online anonymously",
  "What's the best way to search the internet for academic papers?",
  "Summarize why people search the web less now",
  "This page tells you how to find recipes online.",
  "Please summarize this article about online search",
  "Explain the difference between web search and library research",
  "Please explain what the web is",
  "Don't browse the internet",
  "Stop searching the web",
  "Do you search the web?",
  "Does the extension search the web?",
  "Did you search online?",
  "Have you tried searching the web?",
  "Online search is not always reliable",
  "He used the internet to find a job",
  "People use the internet to search for answers",
  "Why do people use the web?",
  "Use the web page's search box",
  "Use the internet archive",
  "Find the answer in the web page above",
  "Find the answer on the web page",
  "Find me a document on the internet protocol",
  "Find all links to online resources",
  "Find out what the article says about online privacy",
  "Look up the word 'online' in the dictionary section",
  "Search for the phrase \"the web\" in this document",
  "I don't want you to search the web for this",
  "Whatever you do, never search the web for my name",
  "Without searching the internet, what is 2+2?",
  "我想知道怎么上网搜索",
  "联网搜索和本地搜索有什么区别",
  "网上搜索是不是不安全",
  "这个功能支持联网搜索吗",
  "它能联网搜索吗？",
  "禁止联网搜索",
  "不用上网查",
  "你不应该联网搜索",
  "这篇文章介绍了网上搜索的几种方法",
  "为什么不联网搜索呢",
  "I don't know how to search the web",
  "People don't search the web anymore",
  "This extension doesn't search the web",
  "Can't you search the web?",
  "How to stop searching the web for everything",
  "I want to stop searching online",
  "这个设备不用联网吗",
  "Instead of searching the web, use the page",
  "Please avoid searching online",
  "There's no need to look it up online",
  "先别联网搜索",
  "你不要联网搜索",
  "切勿联网搜索",
  "不要联网，直接回答",
  "别上网",
  "无需联网",
];
{
  const bad = all(NOT_EXPLICIT, (q) => trigger(q) !== "explicit");
  check(`not explicit: ${NOT_EXPLICIT.length} refusals, how-to questions and compounds ("web search engines", "online stores", "联网搜索功能") are not orders`, bad.length === 0, show(bad));
}

// --- Refusals -----------------------------------------------------------------------
// With no page at all the automatic lookup would normally fire; an explicit "don't" beats it.
const REFUSALS = [
  "Don't search the web, just use the page",
  "Please do not search online for this.",
  "No need to search the internet for it.",
  "Never look it up online",
  "Do not use the internet, only the page.",
  "I'd rather you didn't search the web",
  "Please don't browse the web for this",
  "You don't need to search online",
  "Let's not search the web for this one",
  "Answer from the page, do not search the web",
  "Don't browse the internet",
  "Stop searching the web",
  "I don't want you to search the web for this",
  "Whatever you do, never search the web for my name",
  "Without searching the internet, what is 2+2?",
  "Instead of searching the web, use the page",
  "Please avoid searching online",
  "There's no need to look it up online",
  "不要联网搜索，只根据页面回答",
  "别上网查了",
  "无需联网搜索",
  "请勿联网搜索",
  "我不想联网搜索",
  "请不要上网搜索",
  "禁止联网搜索",
  "不用上网查",
  "你不应该联网搜索",
  "先别联网搜索",
  "你不要联网搜索",
  "切勿联网搜索",
  "不要联网，直接回答",
  "别上网",
  "无需联网",
];
{
  const bad = all(REFUSALS, (q) => trigger(q) === null);
  check(`refusal: ${REFUSALS.length} "don't search the web" statements search nothing, even with no page to answer from`, bad.length === 0, show(bad));
  const bad2 = all(REFUSALS, (q) => trigger(q, unrelatedPage) === null);
  check("refusal: nor does a page that cannot answer the question bring the search back", bad2.length === 0, show(bad2));
  check("refusal: an instruction after a refusal still wins", trigger("Don't search the web for my name. Search the web for the weather in Lisbon.") === "explicit");
  check("refusal: Chinese instruction after a refusal still wins", trigger("不要联网搜索我的名字，请联网搜索里斯本的天气") === "explicit");
}

// --- Said nothing about searching ----------------------------------------------------
// A page that cannot answer still gets the automatic lookup: only a refusal suppresses it.
const NEUTRAL = [
  "你不能联网搜索吗？",
  "How do I search the web safely?",
  "Where can I find a good tutorial online?",
  "Can I search online without a VPN?",
  "Why would someone search online before buying?",
  "Is it safe to browse the internet on public Wi-Fi?",
  "What happens when I run a web search?",
  "The article explains how to search the web effectively.",
  "怎么联网搜索？",
  "如何上网查资料？",
  "网上找工作靠谱吗",
  "上网查资料的好处是什么",
  "网上搜索结果可信吗？",
  "Which web search engines does the article mention?",
  "Find all the online stores mentioned on this page",
  "Search for the word internet in this text",
  "What does the author say about web research?",
  "Summarize the section about online research methods",
  "Look up the definition of 'internet' in the glossary below",
  "Search this web page for the pricing section",
  "Check the web page for spelling errors",
  "Search online stores for deals on this page",
  "Find online courses mentioned in this article",
  "Explain how a web search works",
  "browse the internet archive for old pages",
  "Tell me about the history of the internet",
  "文章里提到了哪些网上搜索技巧？",
  "联网搜索功能是怎么实现的？",
  "这个设备怎么联网",
  "路由器联网失败是什么意思",
  "在线搜索引擎有哪些？",
  "I searched the web yesterday and found nothing",
  "Search engines index the web continuously.",
  "Chrome lets you search the web from the address bar",
  "To search the web, open a new tab.",
  "How to search online anonymously",
  "What's the best way to search the internet for academic papers?",
  "Summarize why people search the web less now",
  "This page tells you how to find recipes online.",
  "Please summarize this article about online search",
  "Explain the difference between web search and library research",
  "Please explain what the web is",
  "Do you search the web?",
  "Does the extension search the web?",
  "Did you search online?",
  "Have you tried searching the web?",
  "Online search is not always reliable",
  "He used the internet to find a job",
  "People use the internet to search for answers",
  "Why do people use the web?",
  "Use the web page's search box",
  "Use the internet archive",
  "Find the answer in the web page above",
  "Find the answer on the web page",
  "Find me a document on the internet protocol",
  "Find all links to online resources",
  "Find out what the article says about online privacy",
  "Look up the word 'online' in the dictionary section",
  "Search for the phrase \"the web\" in this document",
  "我想知道怎么上网搜索",
  "联网搜索和本地搜索有什么区别",
  "网上搜索是不是不安全",
  "这个功能支持联网搜索吗",
  "它能联网搜索吗？",
  "这篇文章介绍了网上搜索的几种方法",
  "为什么不联网搜索呢",
  "I don't know how to search the web",
  "People don't search the web anymore",
  "This extension doesn't search the web",
  "Can't you search the web?",
  "How to stop searching the web for everything",
  "I want to stop searching online",
  "这个设备不用联网吗",
];
{
  const bad = all(NEUTRAL, (q) => trigger(q, unrelatedPage) === "implicit");
  check(`neutral: ${NEUTRAL.length} questions that mention searching without refusing it are still judged by the page`, bad.length === 0, show(bad));
}

// --- The page decides the rest --------------------------------------------------------
const PAGES = {
  p0: "Classic banana bread: mix 3 ripe bananas with 1/3 cup melted butter, 3/4 cup sugar, 1 egg, 1 teaspoon vanilla and 1 teaspoon baking soda. Add 1 1/2 cups flour and bake at 350°F for 60 minutes in a greased loaf pan.",
  p1: "Google announced Chrome 140 on Tuesday, adding a built-in translation panel and faster tab search. The update starts rolling out to desktop users this week and will reach Android next month.",
  p2: "The clinic is open Monday to Friday from 9 am to 5 pm. Appointments can be booked by phone or through the patient portal. Flu shots are available without an appointment on Wednesdays.",
  p3: "Shares of Acme Corp fell 4% on Monday after the company cut its full-year revenue forecast to $2.1 billion, citing weaker demand in Europe.",
  p4: "In Python, a list comprehension builds a new list from an iterable: [x*2 for x in range(5)] returns [0, 2, 4, 6, 8]. Generator expressions use parentheses instead of brackets and compute values lazily.",
  p5: "The museum is closed on Mondays. Adult tickets cost $20 and children under 12 enter free. The Egyptian wing, which includes the famous gold mask, is on the second floor.",
  p6: "香蕉面包做法：三根熟香蕉捣成泥，加入三分之一杯融化的黄油、四分之三杯糖、一个鸡蛋、一茶匙香草精和一茶匙小苏打，再加一杯半面粉，倒入涂油的面包模具，350华氏度烘烤60分钟。",
  p7: "谷歌周二发布了Chrome 140，新增内置翻译面板并加快了标签页搜索速度。该更新本周起向桌面用户推送，下个月将登陆安卓设备。",
  p8: "诊所周一至周五上午九点到下午五点开放。可以通过电话或患者门户预约。每周三无需预约即可接种流感疫苗。",
  p9: "周一，Acme公司股价下跌4%，原因是公司将全年营收预期下调至21亿美元，称欧洲需求疲软。",
  p10: "在Python中，列表推导式可以从可迭代对象构建新列表，例如[x*2 for x in range(5)]返回[0, 2, 4, 6, 8]。生成器表达式使用圆括号而不是方括号，并且惰性计算数值。",
  p11: "博物馆周一闭馆。成人票20美元，12岁以下儿童免费。著名的黄金面具所在的埃及展厅位于二楼。",
  p12: "Kubernetes 1.31 deprecates the in-tree cloud provider integrations. Cluster administrators should migrate to the external cloud controller manager before upgrading. The release also graduates sidecar containers to beta and adds a new field, restartPolicy, for init containers.",
  p13: "The lease runs for twelve months starting on the first of March. Rent is due on the fifth of each month, and a late fee of $50 applies after that. Pets are allowed with a $300 deposit. The tenant must give sixty days' written notice before moving out.",
  p14: "Marie Curie won the Nobel Prize in Physics in 1903, shared with Pierre Curie and Henri Becquerel, for their work on radioactivity. She won the Nobel Prize in Chemistry in 1911 for the discovery of polonium and radium.",
  p15: "To reset the router, hold the reset button for ten seconds until the power light blinks. Then connect to the default network named Router-Setup and open 192.168.0.1 in your browser. The default password is printed on the label underneath the device.",
  p16: "Our refund policy: items can be returned within thirty days of delivery if unused and in the original packaging. Refunds are issued to the original payment method within five business days. Shipping costs are not refunded unless the item arrived damaged.",
  p17: "Mitochondria produce most of the cell's ATP through oxidative phosphorylation. They have their own circular DNA, inherited maternally, and an inner membrane folded into cristae that increases surface area for the electron transport chain.",
  p18: "本次发布将内置云厂商集成标记为弃用。集群管理员应在升级之前迁移到外部云控制器。此外，边车容器晋升为测试版，并为初始化容器新增了restartPolicy字段。",
  p19: "租期为十二个月，从三月一日开始。房租每月五号到期，逾期收取五十美元滞纳金。允许养宠物，需缴纳三百美元押金。租客搬离前必须提前六十天书面通知。",
  p20: "玛丽·居里于1903年与皮埃尔·居里和亨利·贝克勒尔共同获得诺贝尔物理学奖，以表彰他们在放射性方面的研究。1911年，她因发现钋和镭再次获得诺贝尔化学奖。",
  p21: "重置路由器时，按住重置按钮十秒，直到电源灯闪烁。然后连接名为Router-Setup的默认网络，在浏览器中打开192.168.0.1。默认密码印在设备底部的标签上。",
  p22: "退款政策：商品在送达后三十天内，若未使用且包装完好，可以退货。退款将在五个工作日内退回原支付方式。除非商品到货时已损坏，否则运费不予退还。",
  p23: "线粒体通过氧化磷酸化产生细胞所需的大部分ATP。它们拥有自己的环状DNA，由母系遗传，内膜折叠成嵴，增加了电子传递链的表面积。",
};
// Questions the page answers with its own vocabulary stay local ...
const ANSWERED_BY_PAGE = [
  ["p0", "How long should I bake the banana bread?"],
  ["p0", "How many bananas do I need?"],
  ["p1", "When will Chrome 140 reach Android?"],
  ["p1", "What features does the new Chrome update add?"],
  ["p2", "When can I get a flu shot without an appointment?"],
  ["p2", "Is the clinic open on weekends?"],
  ["p2", "How can I book an appointment?"],
  ["p3", "Why did Acme shares drop?"],
  ["p3", "What revenue forecast did Acme announce?"],
  ["p4", "What does a generator expression do differently from a list comprehension?"],
  ["p5", "Where can I see the gold mask?"],
  ["p5", "How much does a ticket cost for an adult?"],
  ["p6", "需要烤多长时间？"],
  ["p6", "要用几根香蕉？"],
  ["p7", "Chrome 140什么时候支持安卓？"],
  ["p7", "这次更新新增了哪些功能？"],
  ["p8", "怎么预约？"],
  ["p9", "Acme股价为什么下跌？"],
  ["p9", "公司下调后的营收预期是多少？"],
  ["p10", "生成器表达式和列表推导式有什么区别？"],
  ["p11", "黄金面具在哪里可以看到？"],
  ["p11", "成人票多少钱？"],
  ["p12", "Do I have to migrate anything before upgrading?"],
  ["p12", "What changed for init containers?"],
  ["p13", "How much is the late fee?"],
  ["p13", "How much notice do I have to give before leaving?"],
  ["p14", "When did she win the prize in chemistry?"],
  ["p14", "Who shared the physics prize with her?"],
  ["p14", "What was the prize in 1911 awarded for?"],
  ["p15", "How long do I hold the reset button?"],
  ["p15", "Where do I find the default password?"],
  ["p16", "What condition must returned items be in?"],
  ["p17", "What are cristae for?"],
  ["p17", "How is mitochondrial DNA inherited?"],
  ["p17", "What does the electron transport chain produce?"],
  ["p18", "升级之前需要做什么？"],
  ["p18", "初始化容器有什么变化？"],
  ["p18", "哪个功能进入了测试版？"],
  ["p19", "滞纳金是多少？"],
  ["p19", "搬走要提前多久通知？"],
  ["p20", "1911年的奖是为了表彰什么？"],
  ["p21", "要按住重置按钮多久？"],
  ["p21", "默认密码在哪里能找到？"],
  ["p21", "重置以后要打开什么地址？"],
  ["p22", "运费能退吗？"],
  ["p22", "退货的商品需要什么状态？"],
  ["p23", "嵴有什么作用？"],
  ["p23", "线粒体DNA是怎么遗传的？"],
  ["p23", "电子传递链产生什么？"],
];
// ... and questions it cannot answer (a different product, a year it never mentions, live data) search.
const NOT_ANSWERED_BY_PAGE = [
  ["p0", "What is the price of ripe bananas at Walmart today?"],
  ["p0", "Is this banana bread recipe the same as the one in the 2026 Betty Crocker cookbook?"],
  ["p1", "What is the latest stable version of Chrome right now?"],
  ["p1", "How does Chrome 140 compare to Firefox 130 in benchmarks?"],
  ["p2", "What are the side effects of the 2026 flu vaccine?"],
  ["p2", "Which pharmacies near Boston also offer flu shots?"],
  ["p3", "What is Acme's stock price right now?"],
  ["p4", "What new features did Python 3.14 add to comprehensions?"],
  ["p4", "Which Python web frameworks are most popular in 2026?"],
  ["p5", "Are there any travel advisories for visiting Egypt this month?"],
  ["p5", "What is the weather forecast for tomorrow near the museum?"],
  ["p6", "今天沃尔玛的香蕉多少钱一斤？"],
  ["p6", "2026年最受欢迎的香蕉面包食谱是哪个？"],
  ["p7", "Chrome现在最新的稳定版本是多少？"],
  ["p7", "Chrome 140和火狐130的跑分对比如何？"],
  ["p8", "2026年流感疫苗有哪些副作用？"],
  ["p8", "波士顿附近哪些药店也能打流感疫苗？"],
  ["p10", "Python 3.14给推导式增加了哪些新特性？"],
  ["p10", "2026年最流行的Python网页框架有哪些？"],
  ["p11", "本月去埃及旅行有没有安全提醒？"],
  ["p11", "明天博物馆附近的天气预报怎么样？"],
  ["p12", "What is the maximum number of nodes Kubernetes supports?"],
  ["p12", "How does this compare with Nomad's scheduling model?"],
  ["p13", "Are late fees capped by law in Ontario?"],
  ["p13", "What is the average rent for a one bedroom in Toronto?"],
  ["p15", "Does this router support Wi-Fi 7?"],
  ["p15", "What is the firmware version released this month?"],
  ["p16", "Is this policy compliant with the EU consumer rights directive?"],
  ["p17", "Which diseases are caused by mitochondrial mutations?"],
  ["p17", "Who discovered mitochondria?"],
  ["p18", "Kubernetes最多支持多少个节点？"],
  ["p18", "它和Nomad的调度模型相比怎么样？"],
  ["p19", "安大略省法律对滞纳金有上限吗？"],
  ["p19", "多伦多一居室的平均租金是多少？"],
  ["p20", "自那以后有多少位女性获得过物理学奖？"],
  ["p20", "居里夫人葬在哪里？"],
  ["p21", "这款路由器支持Wi-Fi 7吗？"],
  ["p21", "这个月发布的固件版本是多少？"],
  ["p22", "这个政策符合欧盟消费者权利指令吗？"],
  ["p23", "线粒体突变会引起哪些疾病？"],
  ["p23", "谁发现了线粒体？"],
];
{
  const bad = ANSWERED_BY_PAGE.filter(([p, q]) => trigger(q, PAGES[p]) !== null);
  check(`implicit: ${ANSWERED_BY_PAGE.length} questions the page answers do not trigger a web search (English and Chinese)`, bad.length === 0, show(bad.map(([, q]) => q)));
  const bad2 = NOT_ANSWERED_BY_PAGE.filter(([p, q]) => trigger(q, PAGES[p]) !== "implicit");
  check(`implicit: ${NOT_ANSWERED_BY_PAGE.length} questions the page cannot answer still trigger one`, bad2.length === 0, show(bad2.map(([, q]) => q)));
  check("implicit: no page at all still triggers one (the rule the opt-out setting gates)", trigger("What is the weather in Lisbon tomorrow?") === "implicit");
  check("implicit: filler-only questions search nothing", trigger("这篇文章讲了什么", "任意页面内容") === null && trigger("What does this article say?", "any page text") === null);
  // Known limit, not asserted: the check is lexical, so a question that rewords the page ("dog" for "pets") still searches.
}

// --- Cost and robustness ----------------------------------------------------------------
{
  const big = (s, n) => s.repeat(n);
  const inputs = {
    "1 MB of 'search online '": big("search online ", 75000),
    "1 MB of 'don't search the web '": big("don't search the web ", 50000),
    "1 MB of 'a search the web, '": big("a search the web, ", 55000),
    "1 MB of 'please ' then 'search online'": big("please ", 140000) + "search online",
    "1 MB of '请你'": big("请你", 500000),
    "1 MB of '不要联网'": big("不要联网", 250000),
    "1 MB of '联网搜索'": big("联网搜索", 250000),
    "1 MB 'search ' + 'a' x 1M": "search " + "a".repeat(1_000_000),
  };
  for (const [label, q] of Object.entries(inputs)) {
    const t0 = process.hrtime.bigint();
    trigger(q, "page");
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    // Measured at 4-155 ms; the slowest input is the page-coverage check on a 1 MB
    // run of CJK filler, which was already that slow. The bound only has to catch
    // super-linear behaviour.
    check(`linear cost: ${label}`, ms < 1500, `${ms.toFixed(1)} ms`);
  }
  const odd = ["", " ", "\n\n", "😀".repeat(2000), "search the web\ud83d", null, undefined, 42];
  let threw = null;
  for (const q of odd) { try { trigger(q, "page"); trigger(q); } catch (e) { threw = e; } }
  check("robust: empty, emoji, lone surrogate and non-string questions do not throw", threw === null, threw && String(threw));
}

console.log(failed ? `\n${failed} check(s) FAILED` : "\nPASS  web-research trigger tests");
process.exit(failed ? 1 : 0);
