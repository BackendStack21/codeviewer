export type ThemeName = "dark" | "light" | "system";

/**
 * Applies a theme with transitions off, so nothing fades into it. A transition started by a theme
 * change does not advance while WebKit is not rendering (hidden or minimized window), which left
 * buttons in the old theme's colour on the new background. The forced layout read commits the new
 * styles before transitions come back; without it they would all start once the attribute is gone.
 */
export function setDocumentTheme(root: HTMLElement, theme: "dark" | "light") {
  root.dataset.themeSwitching = "";
  root.dataset.theme = theme;
  void root.offsetHeight;
  delete root.dataset.themeSwitching;
}

/** Codeviewer.app: syncs the native window (traffic lights, background) with the theme. */
export function nativeThemeMessage(mode: ThemeName, dark: boolean, bg: string) {
  return { t: "theme", mode, dark, bg };
}
