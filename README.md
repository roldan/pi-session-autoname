# pi-session-autoname

Pi extension for naming sessions and herdr tabs.

## Commands

- `/auto-name`: generate a session name from the current session context, apply it as the Pi session name, and rename the herdr tab when running inside herdr.
- `/hname [name]`: rename the current herdr tab. If no name is provided, it uses the current Pi session name, or a fallback label.

## How `/auto-name` works

- uses the active Pi model (`ctx.model`)
- calls the model directly from the extension via Pi's model API (`complete()`), without spawning a nested `pi` process
- samples the visible session transcript using:
  - first 4 conversation messages
  - 4 middle messages
  - last 4 messages
- includes only conversation messages (`user` and `assistant`)
- excludes tool outputs
- renames the Herdr tab to `Loading...` while the title is being generated
- supports both the legacy Herdr CLI and Herdr App: in Herdr App it resolves `$HC_TERMINAL_ID` with `hc get` and renames the associated `herdr.tab` using `herdr-app do tab.rename`

## Install

### Option 1: pi package

```bash
pi install /absolute/path/to/pi-session-autoname
```

Then reload Pi:

```text
/reload
```

### Option 2: local extension directory

```bash
cp -r pi-session-autoname ~/.pi/agent/extensions/
```

Then reload Pi:

```text
/reload
```

### Option 3: npm package

```bash
pi install npm:pi-session-autoname
```

Then reload Pi:

```text
/reload
```

## Usage

- `/auto-name`
- `/hname`
- `/hname "my tab name"`

## Notes

- `/auto-name` requires an active model.
- If you are not in a Herdr tab, only the Pi session name is updated.
- Legacy Herdr is detected with `HERDR_ENV=1` and `HERDR_TAB_ID`. Herdr App is detected when `$HC_TERMINAL_ID` identifies a terminal labelled with `herdr.tab`.
- Herdr auto-rename avoids showing the fallback tab label while an auto-generated name is still pending.
