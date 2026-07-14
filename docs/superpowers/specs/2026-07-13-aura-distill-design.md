# AURA DISTILL — Prompt/Instruction Token-Saver

**Date:** 2026-07-13
**Status:** Approved design → implementation
**Repo:** IzzoIzzoIzzo/aura (`shaddai-aura` on npm), local `OneDrive\Desktop\aura-oss`, branch off `main` (v0.4.0)

## Why

OpenAI's GPT-5.6 prompting guide reports that leaner system prompts improved eval scores
~10-15% while cutting total tokens 41-66% and cost 33-67%. A system prompt is paid for on
**every call, forever** — so trimming it once compounds across every request.

AURA saves tokens on three surfaces. Two exist; this spec adds the third:

| Pillar | Surface | Status |
|---|---|---|
| CACHE / COMPUTE / SKILL | the *answer* | shipped |
| COMPRESS (`context-compress`) | the *history* | shipped |
| **DISTILL** (this spec) | the *instructions / system prompt* | **new** |

DISTILL is the input-side compressor, distinct from COMPRESS (history-side).

## The rubric (from OpenAI's guide — the contract this feature enforces)

**TRIM** — repeated statements of the same rule; repeated style/process instruction that
doesn't change behavior; examples that don't change behavior; process instructions for
behavior the model already performs reliably; full tool descriptions unrelated to the task.

**KEEP** — the user-visible outcome; success criteria and stopping conditions; safety,
business, evidence, and permission constraints; tool-routing rules when the route depends
on context; required output shape and validation requirements.

## Architecture

New module `lib/prompt-distill.js`, plus a CLI command, an MCP tool, and a ledger hook.
Zero-dependency and deterministic on the free path, mirroring the rest of AURA.

### Two-pass model (hybrid — mirrors `aura ask` / `aura ask --llm`)

**Pass 1 — deterministic (free, zero-dep, default):**

1. **Segment** the prompt into units: markdown headings, bullet/numbered list items,
   fenced code blocks (kept whole), and otherwise sentence-split paragraphs.
2. **Protect** — mark any unit carrying a KEEP signal as untouchable. Protection is by
   **structure first, keyword second** (adversarial review #2.1: keyword-only KEEP is brittle
   to rewording). A unit is protected if EITHER it sits under a heading/section whose title
   matches a KEEP category (see 2a), OR it carries a KEEP signal:
   - *safety/permission/business:* `never`, `must not`, `do not`, `always`, `require`,
     `approval`, `authoriz`, `permission`, `pii`, `secret`, `credential`, `compliance`, `confirm`
   - *success/stopping:* `success`, `done when`, `stop when`, `complete when`, `criteria`, `until`
   - *output shape/validation:* `return`, `output`, `format`, `json`, `schema`, `must match`,
     `validate`, `shape`, `fields`
   - *context-dependent tool routing:* an `if … (use|call|route)` / `when … (use|call)` /
     `otherwise` shape (regex), not a bare tool mention
   - **behavior-envelope process (adversarial review #1.2 — the key catch):** instructions
     that read like "process" but actually bound behavior are PROTECTED, not flagged:
     tool-call budgets (`no more than N tools`, `call … at most`, `budget`), uncertainty
     policy (`if unsure`, `if uncertain`, `ask one clarifying`, `state.*unknown`,
     `mark uncertainty`), stop rules (`stop`, `do not continue`, `then act`), escalation
     (`escalate`, `defer to`, `hand off`), hallucination-fallback (`don't fabricate`,
     `if no source`, `say so`). These shape the model's behavior envelope; cutting them
     changes latency/accuracy/risk posture.

2a. **Structural protection & invariants (adversarial review #1.4, #2.1).** Segmentation
    records each unit's enclosing section (nearest preceding markdown heading `#…` or
    XML-ish tag `<constraints>`, `<stop_rules>`, `<safety>`, etc.). If a section's title
    matches a KEEP category, EVERY unit in it is protected wholesale (vocabulary-independent).
    Invariants DISTILL never violates: headings/section labels are never deleted or reordered;
    content is never moved across sections; units are only ever removed *within* their own
    section. This preserves the priority/scope hierarchy the model reads.
3. **Auto-cut** — only among UNPROTECTED units, only provable redundancy:
   - **exact duplicate** rules (normalize: lowercase, collapse whitespace, strip trailing
     punctuation) → keep first occurrence, drop the rest
   - **near-duplicate** rules — zero-dep token-shingle Jaccard similarity ≥ threshold
     (default 0.82) → keep the longest/most-complete, drop the others.
     **Known limit (adversarial review #1.1):** shingle similarity is lexical, so a *deep
     paraphrase* sharing few tokens is NOT detected. We accept this deliberately rather than
     add an embedding model (would break zero-dep). It is safe by construction: paraphrased
     safety/constraint lines are already PROTECTED, so a missed semantic-dup among them just
     means both survive (bloat, not a lost constraint). Deep paraphrase collapse is the
     `--llm` pass's job, gated by the Pass-2 guardrail below.
   - **leading filler** — trim hedge/filler prefixes (`please note that`, `it is important
     to`, `make sure to`, `as mentioned`, `remember to`) without dropping the rule itself
4. **Flag, never cut** — surface judgment-heavy candidates with a reason and category:
   - fenced code / `e.g.` / `for example` blocks → `possible-dead-example`, **but only if a
     matching explicit rule exists elsewhere** (adversarial review #1.3). Cross-reference the
     example's salient keywords against the rule/protected units; if the example is the *sole*
     encoding of a constraint-shaped behavior (no matching rule found), KEEP it silently — it
     is the spec, not decoration.
   - process instructions matching a **purely stylistic** reliable-behavior list
     (`be concise`, `use proper grammar`, `be helpful`, `use markdown`, `be polite`) →
     `model-likely-reliable`. This list is deliberately narrow: it contains NO
     behavior-envelope items (budgets/uncertainty/stop/escalation/fallback) — those are
     PROTECTED in step 2, never flagged (adversarial review #1.2).
   - tool-description blocks whose keywords don't intersect the detected task keywords →
     `possibly-unrelated-tool`
5. **Report** — return everything transparently and reversibly.

**Pass 2 — `--llm` (opt-in, advisory):** feed Pass-1 output + the flags + the TRIM/KEEP
rubric to ONE model call (temperature 0 for stability) that resolves the flags and does the
semantic rewrite. Treated as *advisory*: it can propose, but the rewrite is only accepted if
it passes deterministic validation (adversarial review #3.1/#3.2):
- **Constraint-survival by identity, not words.** Each protected unit gets a stable ID (hash
  of its normalized salient tokens). Every protected ID from the input must still be matchable
  in the output (exact or high-shingle-overlap); any missing ID → reject.
- **Count checks.** #success-criteria units and #output-shape units in the output must be ≥
  those in the input.
- On any failure, reject the rewrite and return Pass-1 output plus a warning listing the
  dropped IDs. The LLM can never silently delete or soften a safety/output/success rule.

### Guarantee

Protected content is never removed by either pass without surfacing it. Same conservative
stance as the skill validator: when unsure, keep and flag — never destroy.

## Public API

`lib/prompt-distill.js` exports:

```
distill(prompt, opts) -> {
  distilled,                         // the leaner prompt (string)
  report: {
    removed:   [{ text, reason }],   // auto-cut (exact-dup | near-dup:0.NN | filler)
    flagged:   [{ text, reason, category }],
    protected: [{ text, category }],
    stats: { tokensBefore, tokensAfter, saved, savedPct, unitsIn, unitsOut }
  }
}
```

- `opts.similarity` (0.82) near-duplicate threshold
- `opts.minLen` (24) ignore units shorter than this for dedup (don't merge tiny bullets)
- `opts.trimFiller` (true)
- Deterministic, no network, no randomness. Token estimate reuses `estTokens`
  (~1 token / 4 chars) for consistency with `context-compress`.

An `applyLLM(pass1, callModel, opts)` helper implements Pass 2 given an injected model
caller (so the core stays key-free / testable); the CLI wires the real caller.

## Surfaces

- **CLI:** `aura distill "<prompt>"` or `aura distill --file <path>`
  - `--llm [--model <id>]` semantic rewrite; `--apply` write the distilled text back to the
    file (with a `.bak` backup); `--json` machine output. Default prints a human diff-style
    report (removed / flagged / protected + savings).
- **MCP:** new tool `aura_distill` — input `{ prompt, similarity?, trimFiller? }`,
  returns `{ distilled, report }`. **Never calls a model** (llm:false), consistent with the
  MCP server's no-key rule. Input capped at `MAX_PROMPT`.
- **Ledger:** distillation `saved` tokens roll into the savings report so `aura_savings`
  reflects prompt-side savings alongside answer-cache and tool-cache.

## Testing (TDD, matches existing `*.test.js` node:test style)

`prompt-distill.test.js` covers, at minimum:
- exact-duplicate rule removed, first kept
- near-duplicate reworded rule removed above threshold, distinct rules kept
- every KEEP category protected (safety, success, output-shape, context tool-routing) —
  never removed even when it looks duplicated
- **behavior-envelope process protected, not flagged** (tool budget, uncertainty policy,
  stop rule, escalation, hallucination-fallback) — never cut, never in `model-likely-reliable`
- **structural protection:** a rule under a `## Constraints` / `<stop_rules>` heading is
  protected even with zero KEEP keywords in the line; headings never deleted/reordered;
  content never moved across sections
- dead example flagged only when a matching rule exists elsewhere; a sole-encoding example
  is KEPT, not flagged
- reliable-behavior / unrelated-tool each flagged, not cut
- leading filler trimmed without losing the rule
- fenced code block kept intact
- stats math correct (before/after/saved/savedPct)
- Pass-2 guardrail: a model output that drops a protected line (by ID) or lowers a
  success/output-shape count is rejected → Pass-1 returned with a warning listing dropped IDs
- input caps / empty / non-string input degrade gracefully (no throw)

MCP: extend `mcp.test.js` — `aura_distill` in `tools/list`, returns a valid result, caps
oversized input, degrades on bad input without throwing.

## Hardening ledger (from adversarial review — 2026-07-13)

**Adopted** (folded into the design above): behavior-envelope process instructions promoted
to PROTECT (#1.2); structural/section-level protection + hierarchy invariants (#2.1, #1.4);
dead-example flag gated on a matching rule existing elsewhere (#1.3); Pass-2 accepted only
via constraint-survival-by-ID + count checks at temperature 0 (#3.1, #3.2).

**Declined, with reason:**
- *Embedding-based semantic dedup (#1.1)* — would break AURA's zero-dependency brand. Limit
  documented and made safe-by-protection; deep paraphrase is the `--llm` pass's job.
- *Constraint DSL / reference-vs-runtime prompt / compliance mappings (#4.2, #2.2)* —
  enterprise scope creep for a dev tool. The `report[]` + `.bak` backup already serve as the
  reversible audit trail.
- *Internal dedup within protected sections (#2.2)* — too risky to auto-merge safety bullets
  in the free pass; protected sections stay whole. The `--llm` pass MAY compress within them,
  but only subject to the constraint-survival-by-ID guardrail.

## Out of scope (follow-on specs, not built here)

- a `distill` mode inside `learn-sessions`
- auto-distilling injected tool schemas
- a published benchmark reproducing the 41-66% cut on real prompts (own spec + `benchmarks/`)

## Rollout

Branch off `main`, TDD the lib, wire CLI + MCP, update README (add DISTILL to the pillar
table + a `## ✦ Distill` section), bump minor version, `npm test` green, then publish +
push. Owner posts on @shaddaiAI.
