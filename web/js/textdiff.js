// Live typing: turns an edit of the phone's text field into the keystrokes
// that make the same edit on the Mac, assuming the Mac's caret sits at the end
// of what we've typed so far. Handles autocorrect and dictation rewriting
// earlier words, and edits in the middle of the field.

const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

// Characters as the Mac's arrow and delete keys count them (👍🏽 is one).
export function graphemes(s) {
  if (segmenter) return Array.from(segmenter.segment(s), (x) => x.segment);
  return Array.from(s);
}

// → { left, back, text }: press ← `left` times, ⌫ `back` times, type `text`,
// then → `left` times. Returns null when nothing changed.
export function diffText(before, after) {
  if (before === after) return null;
  const a = graphemes(before);
  const b = graphemes(after);
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  return { left: s, back: a.length - p - s, text: b.slice(p, b.length - s).join('') };
}
