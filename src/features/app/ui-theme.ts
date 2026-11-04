export type UiTheme = "light" | "dark";
const UI_THEME_KEY = "xingji.ui-theme";
export function readUiTheme(): UiTheme {
  try { return window.localStorage.getItem(UI_THEME_KEY) === "dark" ? "dark" : "light"; }
  catch { return "light"; }
}
export function saveUiTheme(theme: UiTheme): void {
  try { window.localStorage.setItem(UI_THEME_KEY, theme); } catch { /* Current-session appearance still works. */ }
}
