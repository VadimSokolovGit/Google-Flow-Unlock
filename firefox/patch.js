/**
 * Google Flow Unlocker - Patch Engine
 * Disables in-app regional restriction flags (flag 31) and neutralizes /unsupported-country route guards.
 */
(function initializeFlowPatch(globalScope) {
  // Matches expressions like _.Cv(a, 31) or _.vu(a, 31) or any minified function call on Google's namespace object
  const REGION_FLAG_PATTERN = /_\.([a-zA-Z0-9_$]+)\(([a-zA-Z0-9_$]+),\s*31\)/g;
  const AGE_FLAG_PATTERN = /_\.([a-zA-Z0-9_$]+)\(([a-zA-Z0-9_$]+),\s*32\)/g;

  // Matches Angular route guard redirecting to /unsupported-country:
  // e.g. if(!g.Na())return new $o(_.ZB(c,"/unsupported-country"));
  const GUARD_REDIRECT_PATTERN = /if\s*\(![a-zA-Z0-9_$]+\.[a-zA-Z0-9_$]+\(\)\)\s*return\s+new\s+[a-zA-Z0-9_$]+\([^;]*\/unsupported-country[^;]*\);?/;

  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function patchSource(source) {
    console.log("[FlowPatch] Analyzing bundle source... Size:", source.length, "characters");

    const regionMatches = [...source.matchAll(REGION_FLAG_PATTERN)];
    const ageMatches = [...source.matchAll(AGE_FLAG_PATTERN)];

    console.log(`[FlowPatch] Matches found: regionMatches (31) = ${regionMatches.length}, ageMatches (32) = ${ageMatches.length}`);

    let patchedSource = source;
    let patchApplied = false;

    if (regionMatches.length === 1 && ageMatches.length === 1) {
      const regionMatch = regionMatches[0];
      const ageMatch = ageMatches[0];
      const regionFuncName = regionMatch[1];
      const regionArgName = regionMatch[2];
      const ageFuncName = ageMatch[1];
      const ageArgName = ageMatch[2];

      console.log(`[FlowPatch] Detected target call: _.${regionFuncName}(${regionArgName}, 31) (matching age call: _.${ageFuncName}(${ageArgName}, 32))`);

      if (regionFuncName === ageFuncName && regionArgName === ageArgName) {
        const targetPattern = new RegExp(`_\\.${escapeRegex(regionFuncName)}\\(${escapeRegex(regionArgName)},\\s*31\\)`, "g");
        patchedSource = patchedSource.replace(targetPattern, "true");
        console.log(`[FlowPatch] ✅ Successfully replaced '_.${regionFuncName}(${regionArgName}, 31)' with 'true'!`);
        patchApplied = true;
      }
    }

    // Fallback: If signature format differed slightly, replace all occurrences of `_.XX(arg, 31)`
    if (!patchApplied) {
      const nearby31 = [...source.matchAll(/([a-zA-Z0-9_$.]+)\(([a-zA-Z0-9_$]+),\s*31\)/g)];
      if (nearby31.length > 0) {
        console.warn(`[FlowPatch] Attempting fallback patch on ${nearby31.length} candidate matches for flag 31...`);
        for (const m of nearby31) {
          const fn = m[1];
          const arg = m[2];
          const pat = new RegExp(`${escapeRegex(fn)}\\(${escapeRegex(arg)},\\s*31\\)`, "g");
          patchedSource = patchedSource.replace(pat, "true");
          patchApplied = true;
        }
      }
    }

    if (!patchApplied) {
      const errorMsg = "Could not locate regional flag pattern (31) in source bundle.";
      console.error("[FlowPatch] ❌", errorMsg);
      return {
        ok: false,
        error: errorMsg,
        source
      };
    }

    // Neutralize Angular route guard redirecting to /unsupported-country
    if (GUARD_REDIRECT_PATTERN.test(patchedSource)) {
      patchedSource = patchedSource.replace(GUARD_REDIRECT_PATTERN, "/* bypass unsupported-country */");
      console.log("[FlowPatch] ✅ Successfully neutralized /unsupported-country route guard!");
    } else {
      console.warn("[FlowPatch] ⚠️ Route guard pattern not matched directly, relying on flag override");
    }

    return {
      ok: true,
      error: null,
      source: patchedSource
    };
  }

  const patchApi = Object.freeze({ patchSource });
  globalScope.FlowPatch = patchApi;
  globalScope.BezmezhauPatch = patchApi;
})(typeof self !== "undefined" ? self : this);
