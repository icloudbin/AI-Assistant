# Side-panel regression test for the "Read current page" toggle and the
# webmail/banking guard. Loads the REAL sidepanel.js in Chromium with stubbed
# chrome.* APIs.  Needs: pip install playwright (and a Chromium; set
# CHROMIUM_PATH to use a specific binary).   Run: python3 scripts/test-sidepanel-context.py
import sys, json, threading, http.server, functools, os
from playwright.sync_api import sync_playwright
ROOT=os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self,*a,**k): pass
handler=functools.partial(Q, directory=ROOT)
srv=http.server.ThreadingHTTPServer(("127.0.0.1",0),handler); port=srv.server_address[1]
threading.Thread(target=srv.serve_forever,daemon=True).start()

STUB = """
(() => {
  const store = window.__store = JSON.parse(sessionStorage.getItem('__store') || '{}');
  window.__sent = [];
  const D = { tab: { id: 7, windowId: 1, active: true, url: 'https://example.com/a', title: 'Example A' }, ext: { text: 'PAGE TEXT hello world', title: 'Example A', url: 'https://example.com/a' } };
  window.__tab = JSON.parse(sessionStorage.getItem('__tab') || 'null') || D.tab;
  window.__extract = JSON.parse(sessionStorage.getItem('__ext') || 'null') || D.ext;
  const persist = () => sessionStorage.setItem('__store', JSON.stringify(store));
  const ev = () => ({ addListener(){}, removeListener(){} });
  const pick = (keys) => { if (keys == null) return {...store}; if (typeof keys === 'string') keys=[keys]; if (!Array.isArray(keys)) keys=Object.keys(keys); const o={}; for (const k of keys) if (k in store) o[k]=store[k]; return o; };
  window.chrome = {
    runtime: { id: 'x', lastError: undefined, getURL: (p)=>location.origin+'/'+p, sendMessage: async()=>({}), onMessage: ev(), openOptionsPage(){}, 
      connect: () => ({ postMessage: (m) => window.__sent.push(m), disconnect(){}, onMessage: { addListener: (f)=>{ window.__portL=f; }, removeListener(){} }, onDisconnect: ev() }) },
    storage: { local: { get: async (k)=>pick(k), set: async (o)=>{ Object.assign(store,o); persist(); }, remove: async()=>{} }, onChanged: ev() },
    tabs: { query: async()=>[window.__tab], get: async()=>window.__tab, create(){}, sendMessage: (id, msg, cb)=>cb({ ok: true, data: { ...window.__extract } }), onActivated: ev(), onUpdated: ev(), onRemoved: ev(), captureVisibleTab: async()=>'' },
    windows: { WINDOW_ID_NONE: -1, getCurrent: async()=>({id:1}), getAll: async()=>[{id:1,focused:true,type:'normal'}], onFocusChanged: ev() },
    scripting: { executeScript: async()=>[] },
  };
})();
"""
def run(p, fn):
    b=p.chromium.launch(executable_path=os.environ.get("CHROMIUM_PATH") or None, args=["--no-sandbox"])
    ctx=b.new_context(); page=ctx.new_page()
    errs=[]; page.on("pageerror", lambda e: errs.append(str(e)))
    page.add_init_script(STUB)
    page.goto(f"http://127.0.0.1:{port}/sidepanel/sidepanel.html"); page.wait_for_timeout(800)
    r=fn(page); b.close(); return r, errs

def setpage(page, tab, ext):
    page.evaluate("([t,e])=>{sessionStorage.setItem('__tab',JSON.stringify(t));sessionStorage.setItem('__ext',JSON.stringify(e));}", [tab, ext])

def ask(page, q):
    page.evaluate("window.__sent.length=0")
    page.fill("#questionInput", q); page.press("#questionInput","Enter"); page.wait_for_timeout(900)
    res=page.evaluate("window.__sent.filter(m=>m.type==='ASK').map(m=>m.payload)")
    page.evaluate("(id)=>{ if(window.__portL){ window.__portL({type:'START',requestId:id}); window.__portL({type:'CHUNK',delta:'ok',requestId:id}); window.__portL({type:'DONE',requestId:id}); } }", res[-1]["requestId"] if res else None)
    page.wait_for_timeout(300)
    return res

fails=0
def check(name, ok, extra=""):
    global fails
    if not ok: fails+=1
    print(("PASS" if ok else "FAIL"), name, extra)

with sync_playwright() as p:
    # 1. default ON, shows what will be sent
    def t1(page):
        on=page.is_checked("#includeContextToggle"); bar=page.inner_text("#pageContextBar")
        a=ask(page,"what is this?")
        return on,bar,a
    (on,bar,a),errs=run(p,t1)
    check("default is ON", on is True)
    check("bar says what will be sent", "Example A" in bar and "example.com" in bar, repr(bar))
    check("ordinary question sends page", bool(a) and a[0]["includePageContext"] is True and "PAGE TEXT" in json.dumps(a[0]["pageContext"]), json.dumps(a)[:300])
    check("no page errors", not errs, str(errs))

    # 2. turning it off is remembered across panel re-opens (reload keeps sessionStorage-backed store)
    def t2(page):
        page.uncheck("#includeContextToggle"); page.wait_for_timeout(200)
        saved=page.evaluate("window.__store.includeCurrentPageContext")
        page.reload(); page.wait_for_timeout(900)
        on=page.is_checked("#includeContextToggle")
        a=ask(page,"hello")
        return saved,on,a
    (saved,on,a),_=run(p,t2)
    check("opt-out saved to storage", saved is False)
    check("opt-out remembered after reopening the panel", on is False)
    check("and no page is sent", a and a[0]["includePageContext"] is False and a[0]["pageContext"] is None)

    # 3. webmail/banking: not sent, bar explains, allow button works for this session only
    def t3(page):
        setpage(page, {"id":7,"windowId":1,"active":True,**{"url":'https://mail.google.com/mail/u/0/#inbox',"title":'Inbox (3)'}}, {"text":'SECRET EMAIL BODY',"title":'Inbox (3)',"url":'https://mail.google.com/mail/u/0/#inbox'})
        page.reload(); page.wait_for_timeout(900)
        bar=page.inner_text("#pageContextBar"); btn=page.is_visible("#pageContextAllowBtn")
        a=ask(page,"summarize my inbox")
        page.click("#pageContextAllowBtn"); page.wait_for_timeout(300)
        bar2=page.inner_text("#pageContextBar"); btn2=page.is_visible("#pageContextAllowBtn")
        a2=ask(page,"summarize my inbox")
        page.reload(); page.wait_for_timeout(900)
        a3=ask(page,"again")
        return bar,btn,a,bar2,btn2,a2,a3
    (bar,btn,a,bar2,btn2,a2,a3),errs=run(p,t3)
    check("mail site: bar says not sent + offers allow", "mail.google.com" in bar and btn, repr(bar))
    check("mail site: ordinary question does NOT send page", a and a[0]["includePageContext"] is False and "SECRET" not in json.dumps(a[0]))
    check("after Allow: bar shows will-send, button gone", "Will send" in bar2 and not btn2, repr(bar2))
    check("after Allow: page is sent", a2 and a2[0]["includePageContext"] is True and "SECRET EMAIL BODY" in json.dumps(a2[0]["pageContext"]))
    check("allow does not persist to a new panel session", a3 and a3[0]["includePageContext"] is False and "SECRET" not in json.dumps(a3[0]))
    check("no page errors (mail)", not errs, str(errs))

    # 4. self-hosted mail detected by extractor source
    def t4(page):
        setpage(page, {"id":7,"windowId":1,"active":True,**{"url":'https://nas.corp.example:5001/',"title":'MailPlus'}}, {"text":'PRIVATE MAIL',"title":'MailPlus',"url":'https://nas.corp.example:5001/',"source":'synology-mailplus'})
        page.reload(); page.wait_for_timeout(900)
        return ask(page,"what does it say")
    a,_=run(p,t4)
    check("self-hosted mail (extractor source) is blocked", a and a[0]["includePageContext"] is False and "PRIVATE" not in json.dumps(a[0]))

    # 5. quick action still works on a mail page (explicit action)
    def t5(page):
        setpage(page, {"id":7,"windowId":1,"active":True,**{"url":'https://mail.google.com/x',"title":'Inbox'}}, {"text":'MAIL BODY',"title":'Inbox',"url":'https://mail.google.com/x'})
        page.reload(); page.wait_for_timeout(900)
        page.evaluate("window.__sent.length=0")
        btns=page.query_selector_all("button[data-action], .quick-actions button, #quickActions button")
        return len(btns)
    n,_=run(p,t5)
    print("INFO quick-action buttons found:", n)

    # 6. an unexpected exception while preparing a request must not lock the composer
    def t6(page):
        page.evaluate("window.__tab = { id: 7, windowId: 1, active: true, title: 'x', get url() { throw new Error('boom-url'); } }")
        page.evaluate("window.__sent.length=0")
        page.fill("#questionInput", "will this lock the panel?"); page.press("#questionInput", "Enter"); page.wait_for_timeout(900)
        locked = page.evaluate("document.getElementById('sendBtn').disabled || document.getElementById('questionInput').disabled")
        log = page.inner_text("#chatLog")
        draft = page.input_value("#questionInput")
        sent_failed = page.evaluate("window.__sent.filter(m=>m.type==='ASK').length")
        # the panel works again once the tab is readable
        page.evaluate("window.__tab = { id: 7, windowId: 1, active: true, url: 'https://example.com/a', title: 'Example A' }")
        a = ask(page, "second try")
        return locked, log, draft, sent_failed, a
    (locked, log, draft, sent_failed, a), errs = run(p, t6)
    check("exception during prepare: composer is unlocked", locked is False)
    check("exception during prepare: user sees an error", "boom-url" in log, repr(log[-120:]))
    check("exception during prepare: draft text is restored", draft == "will this lock the panel?", repr(draft))
    check("exception during prepare: nothing half-sent", sent_failed == 0)
    check("panel still works afterwards", bool(a) and a[0]["question"].startswith("second try"), json.dumps(a)[:200])
srv.shutdown()
sys.exit(1 if fails else 0)
