#!/usr/bin/env node
// Unit tests for content.js isDefinitelyHidden visibility pruning (#11).
// Run:  node scripts/test-content-visibility.mjs
import assert from "node:assert/strict";

const isDefinitelyHidden = (el) => {
  if (el.hasAttribute?.('hidden') || el.style?.display === 'none') return true;
  if (typeof el.checkVisibility === 'function') {
    try {
      if (!el.checkVisibility({ checkOpacity: false, checkVisibilityCSS: false })) return true;
    } catch {}
  } else if (el !== globalThis.document?.body && el !== globalThis.document?.documentElement && el.offsetParent === null && el.offsetWidth === 0 && el.offsetHeight === 0 && el.style?.position !== 'fixed') {
    try {
      if (globalThis.getComputedStyle(el).position !== 'fixed') return true;
    } catch {
      return true;
    }
  }
  return false;
};

// Mock DOM elements
function makeEl({ hidden = false, display = "", position = "", offsetParent = {}, offsetWidth = 100, offsetHeight = 50, checkVisibility = null } = {}) {
  return {
    hasAttribute: (attr) => attr === "hidden" && hidden,
    style: { display, position },
    offsetParent,
    offsetWidth,
    offsetHeight,
    checkVisibility,
  };
}

// 1. [hidden] attribute
assert.equal(isDefinitelyHidden(makeEl({ hidden: true })), true, "[hidden] element is hidden");

// 2. inline style display: none
assert.equal(isDefinitelyHidden(makeEl({ display: "none" })), true, "style.display='none' is hidden");

// 3. checkVisibility returns false
assert.equal(
  isDefinitelyHidden(makeEl({ checkVisibility: () => false })),
  true,
  "checkVisibility()=false is hidden"
);

// 4. checkVisibility returns true
assert.equal(
  isDefinitelyHidden(makeEl({ checkVisibility: () => true })),
  false,
  "checkVisibility()=true is not hidden"
);

// 5. fallback: offsetParent null, 0x0 size, not fixed
globalThis.getComputedStyle = () => ({ position: "static" });
assert.equal(
  isDefinitelyHidden(makeEl({ offsetParent: null, offsetWidth: 0, offsetHeight: 0 })),
  true,
  "offsetParent=null and 0x0 size without fixed position is hidden"
);

// 6. fallback: position fixed with offsetParent null is NOT pruned
assert.equal(
  isDefinitelyHidden(makeEl({ offsetParent: null, offsetWidth: 0, offsetHeight: 0, position: "fixed" })),
  false,
  "position:fixed with offsetParent=null is NOT hidden"
);

// 7. visible element with geometry
assert.equal(
  isDefinitelyHidden(makeEl({ offsetParent: {}, offsetWidth: 200, offsetHeight: 100 })),
  false,
  "normal element with geometry is not hidden"
);

console.log("OK: content-visibility — [hidden] attribute, display:none, checkVisibility, offsetParent fallback & fixed position protection.");
process.exit(0);
