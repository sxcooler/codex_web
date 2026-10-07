# Settings UX design QA

final result: passed

## Target and evidence

The official screenshots are visual direction, not a pixel-identical clone: this Web app retains its outer workspace/sidebar, supported native capabilities, and explicit save contract. Source images are cropped content or full desktop captures with unknown CSS density; no exact pixel-fidelity claim is made. Implementation captures use Chrome, 1440 × 900 and 390 × 844 CSS pixels at device scale 1, dark theme, isolated API fixtures.

Source: main checkout `.local/web/uploads/00000000-0000-4000-8000-000000000100.png` (configuration); `00000000-0000-4000-8000-000000000101.png` (memory); `00000000-0000-4000-8000-000000000102.png` (credits); `00000000-0000-4000-8000-000000000103.png` (plugins); `00000000-0000-4000-8000-000000000104.png` (reported instruction comparison).

Implementation: `.local/settings-ux/{general,configuration,personalization,usage,plugins,web}-{1440,390}.png`, configuration readonly, memory unknown-write, and scrolled Web/plugins captures. Root opened actual images; configuration source and implementation were emitted in the same comparison input. Further source/implementation comparisons and final instruction evidence pending.

## Iteration 1 findings

- P2: Memory uses square platform checkboxes; target uses compact switches. Keep native input semantics and add scoped switch styling, focus and disabled states.
- P2: Personalization reload button touches the following custom-instructions heading. Restore at least 28px section separation.
- P2: Installed plugins use a separate details row and card per entry, roughly 125px tall. Target and approved design require a compact list. Move expandable details into the entry summary and use a shared list card with dividers; show technical content only when expanded.
- Instruction diff visual/scroll verification is still pending.

## Fidelity surfaces

- Typography: readable system UI text with clear section/title hierarchy. Native app and Chrome font rasterization differ; no substituted display typeface. Long technical paths are collapsed; expanded wrap still requires final check.
- Spacing/layout: configuration controls are compact and right aligned, mobile rows wrap within the viewport. Web maintenance and diagnostics are grouped. Memory section and plugin density issues above remain blocking.
- Color: settings use neutral dark surfaces and borders, preserving the surrounding Web workspace palette. Error and readonly states are distinct; diff semantic colors pending verification.
- Assets: settings pages are text/control based. No new decorative or fake product assets introduced; native plugin logos are not available in the current API and are not fabricated.
- Copy/content: friendly control labels and collapsed implementation details; balance shown separately as 62,500 without invented currency. Unsupported native memory deletion remains explanatory text. Test data is synthetic, not proof of current live account state.

## Implementation checklist

- Apply the three P2 fixes through the UI implementer and recapture identical states.
- Compare final source and implementation together, including instruction diff with long lines.
- Confirm fixed navigation while content scrolls, mobile navigation access, semantic controls, error/CAS guards, and no unexpected console errors in browser verification.
- Set final result to passed only after remaining actionable P0/P1/P2 findings are resolved.

## Iteration 2 — post-fix comparison

Root opened the official memory and plugin source screenshots together with the revised implementation in the same tool input. The memory control is now a native checkbox styled as a switch, custom instructions have a 30px section gap, and plugins share one compact divided list with expandable summaries (about 76px per collapsed desktop entry). All three P2 findings are resolved. Revised evidence: `.local/settings-ux/personalization-1440.png`, `plugins-1440.png`, `plugins-390.png`, captured 2026-10-07 around 12:19 local time.

The reported instruction comparison screenshot and new focused rendered diff were opened together: `.local/settings-ux/instructions-diff-content-split.png` (760px content width) and `instructions-diff-content-unified.png` (358px). Deleted lines have red background/text, added lines green; both include line numbers, and mobile includes explicit +/- markers. `.local/settings-ux/instructions-longline-split.png` shows wrapping confined to the correct column with matched row heights. The shared scroll region avoids independent left/right drift. The 768 × 900 tablet configuration screenshot preserves readable controls and navigation; 390px uses a persistent category selector. Desktop scrolled Web/plugins captures retain the category navigation.

Credits source and implementation were also compared together: the native decimal balance has its own card between usage and reset opportunities, without pretending that recharge controls exist. Differences in surrounding app chrome, fixture text, native capabilities and original screenshot density are intentional; the comparison is of content hierarchy and control quality, not pixel replication.

Focused screenshots make line typography, red/green colors, row alignment and column boundaries readable. No image assets are required for the diff. System font rendering, neutral tokens, disabled/unknown messages and content hierarchy are acceptable. No actionable P0/P1/P2 visual finding remains. Product tests assert navigation retention, overflow bounds, draft/save/error states, diff semantics and console errors. The browser regression gate is separate: the first 51-test run had 50 pass and one plugin fixture readiness failure after the compact markup change. The test now waits for both real summaries before expanding details. The corrected focused run passed 51/51 and the complete Chrome run passed 102/102. Implementation review and Node regression must still pass before release.

## Review follow-up

P2: Password failure feedback is emitted in the runtime card above the form, so a user at the bottom may miss it. Place the failure next to the password form and capture the resulting error state before final acceptance. This finding reopens the visual gate; earlier three P2 fixes remain accepted.

## Iteration 3 — password failure

Root opened .local/settings-ux/password-error.png, 390 x 844 at scale 1: the incorrect-current-password alert is visibly inside the password card between the inputs and submit button. Local runtime errors remain separate. This P2 is resolved; no other visual content changed. Focused Chrome settings-ux 7/7 and text-diff helper 1/1 passed after the password and CR-only fixes. Final visual result is passed.
