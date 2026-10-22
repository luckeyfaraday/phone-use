// Turns WebDriverAgent's UI tree into the numbered element list the Android app returns.
// Coordinates are iOS screen points, the unit WebDriverAgent's taps and swipes take.

const EDITABLE = new Set(["TextField", "SecureTextField", "SearchField", "TextView"]);
const SCROLLABLE = new Set(["ScrollView", "Table", "CollectionView", "WebView"]);
const TAPPABLE = new Set([
  "Button", "Cell", "Link", "Switch", "Toggle", "Slider", "Stepper", "Icon", "MenuItem", "Tab",
  "SegmentedControl", "PageIndicator", "Picker", "PickerWheel", "Key", "Image", "DisclosureTriangle",
  ...EDITABLE,
]);
const LETTER_KEY = /^.$/u; // single-character keyboard keys are noise; keep shift/delete/space/return…
export const MAX_ELEMENTS = 300;

const clip = (s, n = 140) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
// Strip bidi control characters iOS puts around some labels, and collapse whitespace.
const str = (v) => (v === null || v === undefined ? "" : String(v).replace(/[‎‏‪-‮⁦-⁩]/g, "").replace(/\s+/g, " ").trim());
const yes = (v) => v === true || v === "1";

/**
 * tree: GET /source?format=json; size: GET /window/size; app: GET /wda/activeAppInfo.
 * → { app, text, elements, centers } where centers[id] = { x, y, rect } for taps.
 */
export function readTree(tree, size, app = {}) {
  const W = size.width, H = size.height;
  const elements = [], centers = [], lines = [];
  const seen = new Set();
  let truncated = 0;

  const walk = (node, depth, inKeyboard) => {
    const type = node.type ?? "";
    const r = node.rect ?? { x: 0, y: 0, width: 0, height: 0 };
    const onScreen = r.width > 1 && r.height > 1 && r.x < W && r.y < H && r.x + r.width > 0 && r.y + r.height > 0;
    const label = str(node.label) || str(node.name);
    const value = str(node.value);
    const ident = str(node.rawIdentifier);
    const keyboard = inKeyboard || type === "Keyboard";
    let show = onScreen && type !== "Application" && Boolean(label || value || ident || TAPPABLE.has(type) || SCROLLABLE.has(type) || type === "Keyboard");
    if (show && type === "Key" && LETTER_KEY.test(label)) show = false;
    if (show && type === "Other" && !label && !value) show = false;
    if (show && type === "Other" && (r.width < 8 || r.height < 8)) show = false; // scroll indicators
    if (show && type === "Other" && seen.has(label)) show = false; // containers repeating a label already listed
    if (show && type === "Image" && !label) show = false;
    if (show && label) seen.add(label);

    let childDepth = depth;
    if (show) {
      if (elements.length >= MAX_ELEMENTS) {
        truncated++;
      } else {
        const id = elements.length;
        const left = Math.max(0, r.x), top = Math.max(0, r.y);
        const right = Math.min(W, r.x + r.width), bottom = Math.min(H, r.y + r.height);
        const x = Math.round((left + right) / 2), y = Math.round((top + bottom) / 2);
        const tap = TAPPABLE.has(type) || inKeyboard, scroll = SCROLLABLE.has(type), edit = EDITABLE.has(type);
        centers.push({ x, y, rect: { x: left, y: top, width: right - left, height: bottom - top } }); // on-screen part
        elements.push({
          id, role: type, text: label || null, desc: value && value !== label ? value : null, view_id: ident && ident !== label ? ident : null,
          bounds: [Math.round(left), Math.round(top), Math.round(right), Math.round(bottom)], clickable: tap, scrollable: scroll, editable: edit,
        });
        const parts = [`${" ".repeat(Math.min(depth, 12))}[${id}] ${type}`];
        if (label) parts.push(JSON.stringify(clip(label)));
        if (value && value !== label) parts.push(`value=${JSON.stringify(clip(value, 80))}`);
        if (ident && ident !== label) parts.push(`#${clip(ident, 60)}`);
        parts.push(`@${x},${y}`);
        if (tap) parts.push("tap");
        if (scroll) parts.push("scroll");
        if (edit) parts.push("edit");
        if (node.isFocused === true || node.isFocused === "1") parts.push("focused");
        if (node.isEnabled === false || node.isEnabled === "0") parts.push("disabled");
        lines.push(parts.join(" "));
      }
      childDepth = depth + 1;
    }
    for (const child of node.children ?? []) walk(child, childDepth, keyboard);
  };
  walk(tree, 0, false);

  const bundle = app.bundleId ?? null;
  const name = app.name && app.name !== bundle ? ` (${app.name})` : "";
  let text = `app: ${bundle}${name}   screen: ${W}x${H} points\n${lines.join("\n")}`;
  if (!elements.length) text += "\n(no readable elements: the app may draw everything itself; use phone_screenshot)";
  if (truncated) text += `\n… (truncated at ${MAX_ELEMENTS} elements; ${truncated} more not listed)`;
  return { app: bundle, text: text + "\n", elements, centers };
}
