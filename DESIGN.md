# TrueStay Pay: design notes

The rules behind how `/pay` looks and behaves, so every change stays consistent and keeps passing the same checks.
Code lives in `public/pay/app.css` (tokens at the top) and `public/pay/app.js`.

This is the Pay app's own look. The TrueStay social content palette (burnt orange, off-white, charcoal) is a separate thing.

## Look

Lime `#D7F54A` and charcoal `#1B1C19` on a soft grey-green ground. Big rounded cards, big friendly numbers, Outfit for type.
Light, dark, or follow the phone (Settings). Every colour is a token, so light and dark share the same rules.

## Colour tokens

Change a colour by changing its token, never by hard-coding a hex in a rule.

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--bg` | `#E8EBE8` | `#0E0F0D` | page ground |
| `--surface` | `#F5F7F4` | `#1A1C18` | light cards, sheets |
| `--card` | `#1B1C19` | `#1D201A` | dark hero cards |
| `--ink` | `#151613` | `#EEF1E8` | main text |
| `--muted` | `#5B6158` | `#8B9186` | secondary text (5.3:1 or better on the ground and cards, both themes) |
| `--lime` / `--on-lime` | `#D7F54A` / `#1B1C19` | same | primary action, "received" |
| `--red` | `#E9483C` | same | fills only: dots, coins, bars |
| `--red-ink` | `#B42B20` | `#FF9187` | red **text** (passes contrast) |
| `--amber` / `--amber-ink` | `#E89A1C` / `#8A5A08` | `#F5BD55` for text | due but not late |
| `--green` / `--green-ink` | `#22A45D` / `#137140` | `#63D597` for text | paid |

Rules that keep it readable:

- Text on lime or amber is always `--on-lime` (dark). Never white on those.
- Red as a fill uses `--red`; red as text uses `--red-ink`. They are different colours on purpose.
- White text on the green "paid" swipe uses `#178048` (4.98:1), not `--green`.
- Status is never colour alone: overdue, unpaid and paid always come with a word or a tick as well.

## Type

Outfit (Google Fonts), system fallback. Body 16px, line height 1.35.

| Size | Where |
| --- | --- |
| 11px | floor: calendar coins, day totals, tab labels |
| 12 to 13px | secondary lines, captions |
| 14 to 15px | controls, list text |
| 16px | body, and the minimum for any form field (below 16 makes iPhone zoom in when you tap it) |
| 17px | row titles |
| 20 to 22px | card titles |
| 26 to 42px | money figures |

Nothing under 11px. Secondary lines wrap instead of cutting off with an ellipsis, so a name is never half shown.

## Apple HIG numbers the app follows

| Rule | Number |
| --- | --- |
| Tap target | at least 44 x 44px |
| Text | 11px minimum, 16px for form fields |
| Contrast | 4.5:1 for text, 3:1 for large text and UI shapes |
| Focus ring | 2px, offset 2px, dark on light surfaces and lime on dark ones |
| Icon-only buttons | must have an `aria-label` |
| Screen edges | respect `env(safe-area-inset-*)` |
| Motion | switched off under `prefers-reduced-motion` |

### Small controls with a full 44px tap area

Keep the look small, make the tap area 44. Give the control `position: relative` and add this:

```css
.thing { position: relative; }
.thing::after { content: ""; position: absolute; inset: min(0px, calc((100% - 44px) / 2)); }
```

The inset only goes negative on an axis where the control is smaller than 44, so big controls are untouched.
The full list of controls that use it is in the "v4: Apple HIG pass" block at the bottom of `app.css`.
Calendar days use the horizontal-only version so neighbouring rows do not overlap.

Two deliberate exceptions to "just make it 44 visible": the row tick (`.paybtn`) stays 40px visible with a 44px tap area, because 44 visible squeezed client names in a row, and the small tick on the Today card is 34px visible with the same trick.

## Shape and space

- Radii: `--r-xl` 30px, `--r-lg` 24px, `--r-md` 18px, pills fully round
- Page gutter 16px, content max 640px (860px on wide screens)
- Tab bar 64px high, floating, with the round lime add button in the middle
- Toasts sit above the tab bar and disappear after 6s when they have buttons (Undo, Change date), 2.8s when they don't

## Motion

`--ease` for things settling, `--spring` for things that pop or snap (the toast, a paid tick, rows snapping back, bars growing). Most durations sit between .25s and .45s.
Motion helps show what just changed (a paid row settles, a sheet rises). It never blocks a tap.

## Voice

- UK English, plain and direct. Short sentences. No exclamation marks.
- No dashes in sentences. Use a middle dot to separate bits of detail ("PT only · Manual"). A dash on its own means "no value".
- Money as `£120`, with pence only when there are pence. Dates as `Mon 28 Sept`. Times are UK time.
- Empty states say what to do next ("Add your current clients and what they're on.").
- Errors say what happened and what to do, in normal words.
- Numbers agree with their words: "1 day past due", "2 days past due".

## Before shipping any change to `/pay`

Check on a phone-sized screen (390px, and 360px for the narrow case), light and dark:

1. No horizontal scrolling anywhere.
2. Every tap area is 44 x 44px or more, including the invisible extensions.
3. Every text is 11px or more, every form field 16px or more.
4. Text and icons meet the contrast numbers above.
5. Every icon-only button has a name.
6. Empty screens (no clients, no payments) look right, not just the full ones.
7. Bump `?v=` on `app.css` and `app.js` in `index.html` and `SHELL`/`CACHE` in `sw.js` together, so phones pick up the new files.
