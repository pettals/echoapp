# Echo Manual QA Checklist

Use this checklist before marking release lifecycle tasks complete.

## Tray And Menu Lifecycle

- `Open Echo` brings the main Echo window forward from hidden/minimized state.
- `Start Dictation` starts recording from the tray/menu bar menu.
- `Stop Dictation` stops the active recording and continues the normal paste/copy flow.
- `View History` brings Echo forward and opens the History tab.
- `Settings` brings Echo forward and opens Settings.
- Closing the main window hides Echo but keeps global shortcut and tray/menu bar controls alive.
- `Quit Echo` fully exits the app and removes tray/menu bar controls.

## Notes

- On macOS, verify after hiding the window with the red traffic-light close button.
- On Windows, repeat this checklist only after Windows QA hardware is available.

## Launch At Login

- The `Launch Echo at login` toggle is off by default on a fresh config.
- Enabling the toggle and saving Settings registers Echo with the operating system startup/login items.
- Reopening Settings reflects the current operating system launch-at-login state.
- Disabling the toggle and saving Settings removes Echo from startup/login items.
