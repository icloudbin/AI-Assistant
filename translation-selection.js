// Chooses the source text used by context-menu translation.
//
// Chrome's selectionText can flatten paragraph boundaries to one newline.
// The content-script extraction supplies an equivalent plain-text rendition
// whose block boundaries are blank lines, so use it only when it demonstrably
// retains more paragraph separators. Markdown selections retain their richer
// representation and are rendered as Markdown by the side panel.

export function paragraphBreakCount(text) {
  return (String(text || "").match(/\n[\t ]*\n/g) || []).length;
}

export function chooseTranslationSelection(browserText, markdownSelection) {
  const fallback = String(browserText || "").trim();
  const markdownText = String(markdownSelection?.text || "").trim();
  if (!markdownText) return { text: fallback, format: "text", truncated: false };

  if (markdownSelection.structured) {
    return { text: markdownText, format: "markdown", truncated: markdownSelection.truncated === true };
  }

  if (paragraphBreakCount(markdownText) > paragraphBreakCount(fallback)) {
    // The content is still plain text, so the side panel uses pre-wrap and
    // reproduces the recovered blank lines exactly.
    return { text: markdownText, format: "text", truncated: markdownSelection.truncated === true };
  }

  return { text: fallback, format: "text", truncated: false };
}
